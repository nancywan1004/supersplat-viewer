import {
    type AppBase,
    CULLFACE_NONE,
    FILTER_LINEAR,
    PIXELFORMAT_RGBA8,
    BlendState,
    Color,
    Entity,
    Layer,
    Mesh,
    MeshInstance,
    PlaneGeometry,
    Script,
    StandardMaterial,
    Texture,
    type Quat,
    Vec3,
    BLENDEQUATION_ADD,
    BLENDMODE_ONE,
    BLENDMODE_ONE_MINUS_SRC_ALPHA,
    BLENDMODE_SRC_ALPHA
} from 'playcanvas';
import { normalizeAnnotationMediaFields } from './annotation-toolbar/media-fields';
import { ensureHotspotDepthLayers, syncHotspotLayersAfterGsplat } from './scene-assets/hotspot-depth-layers';
import {
    getActiveSceneMediaEntryId,
    setAnnotationFullscreenVideoActive
} from './scene-assets/media/scene-media-playback';
import type { Global } from './types';

// clamp the vertices of the hotspot so it is never clipped by the near or far plane
const depthClampGlsl = `
    float f = gl_Position.z / gl_Position.w;
    if (f > 1.0) {
        gl_Position.z = gl_Position.w;
    } else if (f < -1.0) {
        gl_Position.z = -gl_Position.w;
    }
`;

const depthClampWgsl = `
    let f = output.position.z / output.position.w;
    if (f > 1.0) {
        output.position.z = output.position.w;
    } else if (f < -1.0) {
        output.position.z = -output.position.w;
    }
`;

const vec = new Vec3();

/**
 * A script for creating interactive 3D annotations in a scene. Each annotation consists of:
 *
 * - A 3D hotspot that maintains constant screen-space size. The hotspot is rendered with muted
 * appearance when obstructed by geometry but is still clickable. The hotspot relies on an
 * invisible DOM element that matches the hotspot's size and position to detect clicks.
 * - An annotation panel that shows title and description text.
 */
export class Annotation extends Script {
    static scriptName = 'annotation';

    /** 热点圆直径（屏幕像素） */
    static hotspotSize = 24;

    /** 使用本地 SVG 时图标的 URL，设为空字符串则用 3D 纹理 */
    static hotspotSvgUrl = '/assets/icons/hotspot.svg';

    /** 热点默认颜色（仅 3D 纹理模式有效） */
    static hotspotColor = new Color(1, 1, 1);

    static hoverColor = new Color(1.0, 0.4, 0.0);

    static parentDom: HTMLElement | null = null;

    static styleSheet: HTMLStyleElement | null = null;

    static camera: Entity | null = null;

    static tooltipDom: HTMLDivElement | null = null;

    static titleDom: HTMLDivElement | null = null;

    static textDom: HTMLDivElement | null = null;

    static imageDom: HTMLImageElement | null = null;

    static imagePreviewOverlay: HTMLDivElement | null = null;

    static imagePreviewImg: HTMLImageElement | null = null;

    /** tooltip 内嵌视频容器（展开时小窗播放） */
    static videoInlineDom: HTMLDivElement | null = null;

    static videoInlineEl: HTMLVideoElement | null = null;

    static videoFsBtn: HTMLButtonElement | null = null;

    /**
     * 由 `AnnotationEntity` 首次构造时注入；用于 static handler（fs / 关闭大屏等）
     * 与 `scene-media-playback` 通信触发场景媒体压制状态变更。
     * 单 Global 场景下注入一次即可。
     */
    static globalRef: Global | null = null;

    static videoPlayBtn: HTMLButtonElement | null = null;

    static videoPreviewOverlay: HTMLDivElement | null = null;

    static videoPreviewEl: HTMLVideoElement | null = null;

    static layers: Layer[] = [];

    static mesh: Mesh | null = null;

    static activeAnnotation: Annotation | null = null;

    static hoverAnnotation: Annotation | null = null;

    static opacity = 1.0;

    /**
     * @attribute
     */
    label: string;

    /**
     * @attribute
     */
    title: string;

    /**
     * @attribute
     */
    text: string;

    /**
     * @private
     */
    hotspotDom: HTMLDivElement | null = null;

    /**
     * @private
     */
    texture: Texture | null = null;

    /**
     * @private
     */
    materials: StandardMaterial[] = [];

    /**
     * Injects required CSS styles into the document.
     * @param {number} size - The size of the hotspot in screen pixels.
     * @private
     */
    static _injectStyles(size: number) {
        const css = `
            .pc-annotation {
                display: block;
                position: absolute;
                background-color: rgba(0, 0, 0, 0.5);
                color: white;
                padding: 10px 14px;
                border-radius: 4px;
                font-size: 14px;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
                pointer-events: auto;
                max-width: 280px;
                word-wrap: break-word;
                overflow-x: visible;
                white-space: normal;
                width: fit-content;
                text-align: center;
                opacity: 0;
                transition: opacity 0.2s ease-in-out;
                visibility: hidden;
            }
            .pc-annotation--selected {
                border: 1px solid rgba(0, 191, 255, 0.41);
                box-shadow: 0 0 0 3px rgba(0, 191, 255, 0.41);
            }

            .pc-annotation-title {
                font-weight: bold;
                margin: 0 0 6px 0;
                text-align: center;
            }

            .pc-annotation-text {
                margin: 0;
                text-align: center;
                line-height: 1.4;
            }

            /* Tooltip arrow */
            .pc-annotation.arrow-right::before,
            .pc-annotation.arrow-left::before {
                content: "";
                position: absolute;
                top: var(--arrow-top, 50%);
                transform: translateY(-50%);
                border-top: 8px solid transparent;
                border-bottom: 8px solid transparent;
            }

            .pc-annotation.arrow-right::before {
                left: -8px;
                border-right: 8px solid rgba(0, 0, 0, 0.58);
            }

            .pc-annotation.arrow-left::before {
                right: -8px;
                border-left: 8px solid rgba(0, 0, 0, 0.58);
            }

            .pc-annotation-hotspot {
                display: none;
                position: absolute;
                width: ${size + 5}px;
                height: ${size + 5}px;
                opacity: 0;
                cursor: pointer;
                transform: translate(-50%, -50%);
            }
            .pc-annotation-hotspot--svg {
                opacity: 1;
                width: 24px;
                height: 24px;
            }
            .pc-annotation-hotspot--svg .pc-annotation-hotspot__img {
                width: 100%;
                height: 100%;
                display: block;
                pointer-events: none;
            }
            .pc-annotation-hotspot--selected {
                filter: drop-shadow(0 0 8px rgba(0, 191, 255, 0.41));
            }

            /* 收起时标题：深灰圆角 pill */
            .pc-annotation-collapsed-title {
                background: rgba(45, 45, 45, 0.5);
                color: #fff;
                padding: 5px 12px;
                border-radius: 8px;
                font-size: 12px;
                font-weight: 400;
                font-family: sans-serif;
                white-space: nowrap;
                box-sizing: border-box;
                position: relative;
                text-shadow: none;
            }
            .pc-annotation-collapsed-title--selected {
                box-shadow: 0 0 0 3px rgba(0, 191, 255, 0.41);
            }

            /* 图片预览遮罩层 */
            .pc-annotation-image-preview-overlay {
                position: fixed;
                inset: 0;
                background: rgba(0,0,0,0.75);
                display: none;
                align-items: center;
                justify-content: center;
                z-index: 9999;
            }
            .pc-annotation-image-preview-overlay img,
            .pc-annotation-image-preview-overlay video {
                max-width: 80vw;
                max-height: 80vh;
                border-radius: 8px;
                box-shadow: 0 12px 40px rgba(0,0,0,0.5);
            }
            .pc-annotation-video-inline {
                display: none;
                position: relative;
                width: 100%;
                margin-top: 8px;
                border-radius: 6px;
                overflow: hidden;
                background: rgba(0, 0, 0, 0.35);
            }
            .pc-annotation-video-inline-el {
                display: block;
                width: 100%;
                max-height: 148px;
                min-height: 88px;
                object-fit: cover;
                background: #0a1020;
                pointer-events: none;
            }
            .pc-annotation-video-fs-btn {
                position: absolute;
                top: 8px;
                right: 8px;
                z-index: 2;
                width: 28px;
                height: 28px;
                padding: 0;
                border: none;
                border-radius: 4px;
                background: rgba(0, 0, 0, 0.5);
                cursor: pointer;
                box-sizing: border-box;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .pc-annotation-video-fs-btn__img {
                width: 16px;
                height: 16px;
                display: block;
                pointer-events: none;
            }
            .pc-annotation-video-play-btn {
                position: absolute;
                right: 10px;
                bottom: 10px;
                z-index: 2;
                width: 28px;
                height: 28px;
                padding: 0;
                border: none;
                border-radius: 50%;
                background: rgba(0, 0, 0, 0.55);
                cursor: pointer;
            }
            .pc-annotation-video-play-btn::after {
                content: '';
                position: absolute;
                left: 10px;
                top: 8px;
                border-style: solid;
                border-width: 6px 0 6px 10px;
                border-color: transparent transparent transparent #fff;
            }
            .pc-annotation-video-play-btn.is-playing::after {
                left: 9px;
                top: 8px;
                border: none;
                width: 3px;
                height: 12px;
                background: #fff;
                box-shadow: 6px 0 0 #fff;
            }
        `;

        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
        Annotation.styleSheet = style;
    }

    /**
     * Initialize static resources.
     * @param {AppBase} app - The application instance
     * @private
     */
    static _initializeStatic(app: AppBase) {
        if (Annotation.styleSheet) {
            syncHotspotLayersAfterGsplat(app);
            return;
        }

        Annotation._injectStyles(Annotation.hotspotSize);

        if (Annotation.parentDom === null) {
            Annotation.parentDom = document.body;
        }

        if (Annotation.camera === null) {
            Annotation.camera = app.root.findComponent('camera').entity;
        }

        const { baseLayer, overlayLayer } = ensureHotspotDepthLayers(app, Annotation.camera);
        Annotation.layers = [baseLayer, overlayLayer];

        Annotation.mesh = Mesh.fromGeometry(app.graphicsDevice, new PlaneGeometry({
            widthSegments: 1,
            lengthSegments: 1
        }));

        // Initialize tooltip dom
        Annotation.tooltipDom = document.createElement('div');
        Annotation.tooltipDom.className = 'pc-annotation';

        Annotation.titleDom = document.createElement('div');
        Annotation.titleDom.className = 'pc-annotation-title';
        Annotation.tooltipDom.appendChild(Annotation.titleDom);

        Annotation.textDom = document.createElement('div');
        Annotation.textDom.className = 'pc-annotation-text';
        Annotation.tooltipDom.appendChild(Annotation.textDom);

        // 可选图片元素（AnnotationEntity 展开时显示）
        Annotation.imageDom = document.createElement('img');
        Annotation.imageDom.className = 'pc-annotation-image';
        Annotation.imageDom.style.cssText = 'display:none;max-width:100%;max-height:100px;margin-top:4px;border-radius:4px;cursor:pointer;';
        Annotation.tooltipDom.appendChild(Annotation.imageDom);

        // 图片大图预览遮罩
        Annotation.imagePreviewOverlay = document.createElement('div');
        Annotation.imagePreviewOverlay.className = 'pc-annotation-image-preview-overlay';
        Annotation.imagePreviewOverlay.style.display = 'none';
        Annotation.imagePreviewImg = document.createElement('img');
        Annotation.imagePreviewOverlay.appendChild(Annotation.imagePreviewImg);
        Annotation.imagePreviewOverlay.addEventListener('click', (ev) => {
            if (ev.target === Annotation.imagePreviewImg) {
                return;
            }
            Annotation.closeMediaPreviews();
        });

        if (Annotation.imageDom) {
            Annotation.imageDom.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const src = Annotation.imageDom!.src;
                if (!src) return;
                Annotation.closeMediaPreviews();
                if (Annotation.imagePreviewImg) {
                    Annotation.imagePreviewImg.src = src;
                }
                if (Annotation.imagePreviewOverlay) {
                    Annotation.imagePreviewOverlay.style.display = 'flex';
                }
            });
            // 若图片加载失败（404/跨域等），视为无图：隐藏并清空 src，避免 Tooltip 中出现破图占位
            Annotation.imageDom.addEventListener('error', () => {
                Annotation.imageDom!.removeAttribute('src');
                Annotation.imageDom!.style.display = 'none';
            });
        }

        Annotation.videoInlineDom = document.createElement('div');
        Annotation.videoInlineDom.className = 'pc-annotation-video-inline';

        Annotation.videoInlineEl = document.createElement('video');
        Annotation.videoInlineEl.className = 'pc-annotation-video-inline-el';
        Annotation.videoInlineEl.preload = 'metadata';
        Annotation.videoInlineEl.playsInline = true;
        Annotation.videoInlineEl.setAttribute('playsinline', '');
        Annotation.videoInlineEl.controls = false;
        Annotation.videoInlineDom.appendChild(Annotation.videoInlineEl);

        Annotation.videoFsBtn = document.createElement('button');
        Annotation.videoFsBtn.type = 'button';
        Annotation.videoFsBtn.className = 'pc-annotation-video-fs-btn';
        Annotation.videoFsBtn.setAttribute('aria-label', '全屏播放');
        const videoFsIcon = document.createElement('img');
        videoFsIcon.src = '/assets/icons/expand.svg';
        videoFsIcon.alt = '';
        videoFsIcon.className = 'pc-annotation-video-fs-btn__img';
        Annotation.videoFsBtn.appendChild(videoFsIcon);
        Annotation.videoInlineDom.appendChild(Annotation.videoFsBtn);

        Annotation.videoPlayBtn = document.createElement('button');
        Annotation.videoPlayBtn.type = 'button';
        Annotation.videoPlayBtn.className = 'pc-annotation-video-play-btn';
        Annotation.videoPlayBtn.setAttribute('aria-label', '播放或暂停');
        Annotation.videoInlineDom.appendChild(Annotation.videoPlayBtn);

        Annotation.tooltipDom.appendChild(Annotation.videoInlineDom);

        const syncInlinePlayBtn = () => Annotation._syncInlineVideoPlayButton();

        Annotation.videoInlineEl.addEventListener('play', syncInlinePlayBtn);
        Annotation.videoInlineEl.addEventListener('pause', syncInlinePlayBtn);
        Annotation.videoInlineEl.addEventListener('ended', syncInlinePlayBtn);

        Annotation.videoPlayBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const el = Annotation.videoInlineEl;
            if (!el?.src) return;
            if (el.paused || el.ended) {
                el.muted = false;
                el.removeAttribute('muted');
                void el.play();
            } else {
                el.pause();
            }
        });

        Annotation.videoFsBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const inline = Annotation.videoInlineEl;
            const url = inline?.src;
            if (!url || !Annotation.videoPreviewEl || !Annotation.videoPreviewOverlay) {
                return;
            }
            const t = inline.currentTime;
            inline.pause();
            Annotation.videoPreviewEl.src = url;
            Annotation.videoPreviewEl.currentTime = Number.isFinite(t) ? t : 0;
            Annotation.videoPreviewEl.muted = false;
            Annotation.videoPreviewEl.removeAttribute('muted');
            Annotation.videoPreviewOverlay.style.display = 'flex';
            void Annotation.videoPreviewEl.play();
            // 进入大屏：压制场景音视频（场景视频静音保帧、场景音频暂停），让大屏独占声音
            Annotation._setSceneSuppress(true);
            Annotation._syncInlineVideoPlayButton();
        });

        Annotation.videoInlineEl.addEventListener('error', () => {
            if (Annotation.videoInlineDom) {
                Annotation.videoInlineDom.style.display = 'none';
            }
            if (Annotation.videoInlineEl) {
                Annotation.videoInlineEl.removeAttribute('src');
            }
        });

        Annotation.videoPreviewOverlay = document.createElement('div');
        Annotation.videoPreviewOverlay.className = 'pc-annotation-image-preview-overlay';
        Annotation.videoPreviewOverlay.style.display = 'none';
        Annotation.videoPreviewEl = document.createElement('video');
        Annotation.videoPreviewEl.controls = true;
        Annotation.videoPreviewEl.playsInline = true;
        // 全屏预览须可出声（用户点击缩略后 play，属用户手势）；与 tooltip 内 muted 海报区分
        Annotation.videoPreviewEl.muted = false;
        Annotation.videoPreviewEl.removeAttribute('muted');
        Annotation.videoPreviewOverlay.appendChild(Annotation.videoPreviewEl);
        Annotation.videoPreviewOverlay.addEventListener('click', (ev) => {
            if (ev.target === Annotation.videoPreviewEl) {
                return;
            }
            // 用户主动关闭 video 大屏：解除场景压制 + inline 静音继续播
            Annotation.closeMediaPreviews({ keepInlineMutedPlaying: true });
        });
        Annotation.videoPreviewEl.addEventListener('click', (ev) => ev.stopPropagation());

        Annotation.parentDom.appendChild(Annotation.tooltipDom);
        Annotation.parentDom.appendChild(Annotation.imagePreviewOverlay);
        Annotation.parentDom.appendChild(Annotation.videoPreviewOverlay);
    }

    /** Sync tooltip image/video (mutually exclusive). */
    static syncTooltipMedia(imageUrl?: string, videoUrl?: string): void {
        const media = normalizeAnnotationMediaFields({ imageUrl, videoUrl });

        if (Annotation.imageDom) {
            Annotation.imageDom.style.display = 'none';
            Annotation.imageDom.removeAttribute('src');
        }
        Annotation.pauseInlineVideo();
        if (Annotation.videoInlineDom) {
            Annotation.videoInlineDom.style.display = 'none';
            delete Annotation.videoInlineDom.dataset.videoUrl;
        }
        if (Annotation.videoInlineEl) {
            Annotation.videoInlineEl.removeAttribute('src');
            Annotation.videoInlineEl.load();
        }

        if (media.imageUrl && Annotation.imageDom) {
            Annotation.imageDom.src = media.imageUrl;
            Annotation.imageDom.style.display = 'block';
        } else if (media.videoUrl && Annotation.videoInlineDom && Annotation.videoInlineEl) {
            Annotation.videoInlineDom.dataset.videoUrl = media.videoUrl;
            Annotation.videoInlineEl.src = media.videoUrl;
            Annotation.videoInlineDom.style.display = 'block';
            Annotation._syncInlineVideoPlayButton();
        }
    }

    static _syncInlineVideoPlayButton(): void {
        const btn = Annotation.videoPlayBtn;
        const el = Annotation.videoInlineEl;
        if (!btn || !el) return;
        const playing = !el.paused && !el.ended;
        btn.classList.toggle('is-playing', playing);
        btn.setAttribute('aria-label', playing ? '暂停' : '播放');
    }

    static pauseInlineVideo(): void {
        const el = Annotation.videoInlineEl;
        if (!el) return;
        el.pause();
        Annotation._syncInlineVideoPlayButton();
    }

    /**
     * 锚定展开时在小窗内自动播放（点击热点展开属用户手势，可出声）。
     *
     * @param opts.unmuted 锚定展开默认希望"有声"播放；但若场景中已有音视频在出声
     *   （`getActiveSceneMediaEntryId() !== null`），则改为静音播放以避免互相打扰，
     *   用户可后续点 inline 播放钮或 fs 按钮显式 unmute / 进大屏。
     * @param opts.forceMuted 强制静音（用于「退出大屏后 inline 默认继续静音播放」场景）。
     */
    static playInlineVideo(opts?: { unmuted?: boolean; forceMuted?: boolean }): void {
        const el = Annotation.videoInlineEl;
        if (!el?.src || Annotation.videoInlineDom?.style.display === 'none') {
            return;
        }
        if (opts?.forceMuted) {
            el.muted = true;
            el.setAttribute('muted', '');
        } else if (opts?.unmuted) {
            const sceneSounding = getActiveSceneMediaEntryId() !== null;
            el.muted = sceneSounding;
            if (sceneSounding) {
                el.setAttribute('muted', '');
            } else {
                el.removeAttribute('muted');
            }
        }
        void el.play().catch(() => {
            // 自动播放策略失败时保持静音海报，用户可点播放钮
            el.muted = true;
            void el.play().catch(() => {});
        });
        Annotation._syncInlineVideoPlayButton();
    }

    /** 通知场景媒体压制开关变更；通过 `globalRef.events` 触发控制器立即重算 */
    static _setSceneSuppress(active: boolean): void {
        if (!Annotation.globalRef) return;
        setAnnotationFullscreenVideoActive(Annotation.globalRef, active);
    }

    /**
     * Close fullscreen image/video previews and stop playback.
     *
     * @param opts.keepInlineMutedPlaying 用户主动关闭 video 大屏时传 true：
     *   - 解除场景媒体压制（场景音视频恢复声音）；
     *   - inline 视频静音继续播放（不暂停、不归零进度）。
     *   其它路径（_hideElements 等）保持旧行为：pause inline。
     */
    static closeMediaPreviews(opts?: { keepInlineMutedPlaying?: boolean }): void {
        const wasVideoFullscreen = Annotation.videoPreviewOverlay?.style.display === 'flex';

        if (Annotation.imagePreviewOverlay) {
            Annotation.imagePreviewOverlay.style.display = 'none';
        }
        if (Annotation.imagePreviewImg) {
            Annotation.imagePreviewImg.removeAttribute('src');
        }
        if (Annotation.videoPreviewOverlay) {
            Annotation.videoPreviewOverlay.style.display = 'none';
        }
        if (Annotation.videoPreviewEl) {
            Annotation.videoPreviewEl.pause();
            Annotation.videoPreviewEl.removeAttribute('src');
            Annotation.videoPreviewEl.load();
            Annotation.videoPreviewEl.muted = false;
            Annotation.videoPreviewEl.removeAttribute('muted');
        }

        // 关闭 video 大屏 → 解除场景媒体压制（idempotent，关 image 大屏也安全）
        if (wasVideoFullscreen) {
            Annotation._setSceneSuppress(false);
        }

        if (opts?.keepInlineMutedPlaying) {
            // 退出大屏后 inline 默认继续静音播放
            Annotation.playInlineVideo({ forceMuted: true });
        } else {
            Annotation.pauseInlineVideo();
        }
    }

    /**
     * Creates a circular hotspot texture.
     * @param {AppBase} app - The PlayCanvas AppBase
     * @param {string} label - Label text to draw on the hotspot
     * @param {number} [size] - The texture size (should be power of 2)
     * @param {number} [borderWidth] - The border width in pixels
     * @returns {Texture} The hotspot texture
     * @private
     */
    static _createHotspotTexture(app: AppBase, label: string, size = 64, borderWidth = 4) {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = 'white';
        ctx.globalAlpha = 0;
        ctx.fillRect(0, 0, size, size);
        ctx.globalAlpha = 1.0;

        const centerX = size / 2;
        const centerY = size / 2;
        const radius = (size / 2) - borderWidth;

        // 蓝心：实心圆
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
        ctx.fillStyle = '#2196F3';
        ctx.fill();

        // 白环：外描边
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
        ctx.lineWidth = borderWidth;
        ctx.strokeStyle = 'white';
        ctx.stroke();

        if (label) {
            ctx.font = 'bold 20px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = 'white';
            ctx.fillText(label, centerX, centerY + 1);
        }

        // get pixel data
        const imageData = ctx.getImageData(0, 0, size, size);
        const data = imageData.data;

        // set the color channel of semitransparent pixels to white so the blending at
        // the edges is correct
        for (let i = 0; i < data.length; i += 4) {
            const a = data[i + 3];
            if (a < 255) {
                data[i] = 255;
                data[i + 1] = 255;
                data[i + 2] = 255;
            }
        }

        const texture = new Texture(app.graphicsDevice, {
            width: size,
            height: size,
            format: PIXELFORMAT_RGBA8,
            magFilter: FILTER_LINEAR,
            minFilter: FILTER_LINEAR,
            mipmaps: false,
            levels: [new Uint8Array(data.buffer)]
        });

        return texture;
    }

    /**
     * Creates a material for hotspot rendering.
     * @param {Texture} texture - The texture to use for emissive and opacity
     * @param {object} [options] - Material options
     * @param {number} [options.opacity] - Base opacity multiplier
     * @param {boolean} [options.depthTest] - Whether to perform depth testing
     * @param {boolean} [options.depthWrite] - Whether to write to depth buffer
     * @returns {StandardMaterial} The configured material
     * @private
     */
    static _createHotspotMaterial(texture: Texture, { opacity = 1, depthTest = true, depthWrite = true } = {}) {
        const material = new StandardMaterial();

        // Base properties
        material.diffuse = Color.BLACK;
        material.emissive.copy(Annotation.hotspotColor);
        material.emissiveMap = texture;
        material.opacityMap = texture;

        // Alpha properties
        material.opacity = opacity;
        material.alphaTest = 0.01;
        material.blendState = new BlendState(
            true,
            BLENDEQUATION_ADD, BLENDMODE_SRC_ALPHA, BLENDMODE_ONE_MINUS_SRC_ALPHA,
            BLENDEQUATION_ADD, BLENDMODE_ONE, BLENDMODE_ONE
        );

        // Depth properties
        material.depthTest = depthTest;
        material.depthWrite = depthWrite;

        // Rendering properties
        material.cull = CULLFACE_NONE;
        material.useLighting = false;

        material.shaderChunks.glsl.add({
            'litUserMainEndVS': depthClampGlsl
        });
        material.shaderChunks.wgsl.add({
            'litUserMainEndVS': depthClampWgsl
        });

        material.update();
        return material;
    }

    initialize() {
        // Ensure static resources are initialized
        Annotation._initializeStatic(this.app);

        // Create texture
        this.texture = Annotation._createHotspotTexture(this.app, this.label);

        // Create material the base and overlay material
        this.materials = [
            Annotation._createHotspotMaterial(this.texture, {
                opacity: 1,
                depthTest: true,
                depthWrite: false
            }),
            Annotation._createHotspotMaterial(this.texture, {
                opacity: 0.25,
                depthTest: false,
                depthWrite: false
            })
        ];

        const base = new Entity('base');
        const baseMi = new MeshInstance(Annotation.mesh, this.materials[0]);
        baseMi.cull = false;
        base.addComponent('render', {
            layers: [Annotation.layers[0].id],
            meshInstances: [baseMi]
        });

        const overlay = new Entity('overlay');
        const overlayMi = new MeshInstance(Annotation.mesh, this.materials[1]);
        overlayMi.cull = false;
        overlay.addComponent('render', {
            layers: [Annotation.layers[1].id],
            meshInstances: [overlayMi]
        });

        this.entity.addChild(base);
        this.entity.addChild(overlay);

        // 使用本地 SVG 时隐藏 3D 热点，改为在 DOM 中显示 SVG
        if (Annotation.hotspotSvgUrl) {
            base.enabled = false;
            overlay.enabled = false;
        }

        // Create hotspot dom
        this.hotspotDom = document.createElement('div');
        this.hotspotDom.className = 'pc-annotation-hotspot';

        if (Annotation.hotspotSvgUrl) {
            const img = document.createElement('img');
            img.src = Annotation.hotspotSvgUrl;
            img.alt = '';
            img.className = 'pc-annotation-hotspot__img';
            this.hotspotDom.appendChild(img);
            this.hotspotDom.classList.add('pc-annotation-hotspot--svg');
        }

        this.hotspotDom.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showTooltip();
        });

        if ((this as any).closeOnDocumentClick !== false) {
            document.addEventListener('click', () => {
                if (Annotation.activeAnnotation === this) {
                    this.hideTooltip();
                }
            });
        }

        Annotation.parentDom.appendChild(this.hotspotDom);

        const prerenderHandler = () => this._update();

        // Clean up on entity destruction
        this.on('destroy', () => {
            this.app.off('prerender', prerenderHandler);
            this.hotspotDom?.remove();
            this.hotspotDom = null;
            if (Annotation.activeAnnotation === this) {
                this.hideTooltip();
            }

            this.materials.forEach(mat => mat.destroy());
            this.materials = [];

            this.texture?.destroy();
            this.texture = null;
        });

        this.app.on('prerender', prerenderHandler);
    }

    /**
     * Update screen-space elements and materials for this annotation. Called each frame from the
     * prerender callback, and also directly from showTooltip to ensure the tooltip is positioned
     * correctly even when the camera hasn't moved (e.g. annotations sharing the same camera pose).
     * @private
     */
    _update() {
        if (!Annotation.camera || !this.materials?.length || !this.entity) return;
        // entity.enabled=false 时引擎不跑 script update，但本类仍挂在 app.prerender 上，必须自行隐藏 DOM/热点
        if (!this.entity.enabled) {
            this._hideElements();
            return;
        }

        const position = this.entity.getPosition();
        const screenPos = Annotation.camera.camera.worldToScreen(position);

        const { viewMatrix } = Annotation.camera.camera;
        viewMatrix.transformPoint(position, vec);
        if (vec.z >= 0) {
            this._hideElements();
            return;
        }

        this._updatePositions(screenPos);
        this._updateRotationAndScale(-vec.z);

        // update material opacity and also directly on the uniform so we
        // can avoid a full material update
        this.materials[0].opacity = Annotation.opacity;
        this.materials[1].opacity = 0.25 * Annotation.opacity;
        this.materials[0].setParameter('material_opacity', Annotation.opacity);
        this.materials[1].setParameter('material_opacity', 0.25 * Annotation.opacity);
    }

    /**
     * Set the hover state of the annotation.
     * @param hover - Whether the annotation is hovered
     * @private
     */
    setHover(hover: boolean) {
        if (!Annotation.hotspotSvgUrl && this.materials.length > 0) {
            this.materials.forEach((material) => {
                material.emissive.copy(hover ? Annotation.hoverColor : Annotation.hotspotColor);
                material.update();
            });
        }
        this.fire('hover', hover);
    }

    /**
     * @private
     */
    showTooltip() {
        Annotation.activeAnnotation = this;
        Annotation.tooltipDom.style.visibility = 'visible';
        Annotation.tooltipDom.style.opacity = '1';
        Annotation.titleDom.textContent = this.title;
        Annotation.textDom.textContent = this.text;
        if (Annotation.imageDom) {
            Annotation.imageDom.style.display = 'none';
        }

        // Immediately update incase the camera doesn't move
        this._update();

        this.fire('show', this);
    }

    /**
     * @private
     */
    hideTooltip() {
        Annotation.pauseInlineVideo();
        Annotation.activeAnnotation = null;
        Annotation.tooltipDom.style.opacity = '0';

        // Wait for fade out before hiding
        setTimeout(() => {
            if (Annotation.tooltipDom.style.opacity === '0') {
                Annotation.tooltipDom.style.visibility = 'hidden';
                this.fire('hide');
            }
        }, 200); // Match the transition duration
    }

    /**
     * Hide all elements when annotation is behind camera.
     * @private
     */
    _hideElements() {
        if (this.hotspotDom) {
            this.hotspotDom.style.display = 'none';
        }
        if (Annotation.activeAnnotation === this) {
            Annotation.tooltipDom.style.visibility = 'hidden';
            Annotation.tooltipDom.style.opacity = '0';
        }
        Annotation.closeMediaPreviews();
    }

    /**
     * Update screen-space positions of HTML elements.
     * @param {Vec3} screenPos - Screen coordinate
     * @private
     */
    _updatePositions(screenPos: Vec3) {
        // Show and position hotspot
        this.hotspotDom.style.display = 'block';
        this.hotspotDom.style.left = `${screenPos.x}px`;
        this.hotspotDom.style.top = `${screenPos.y}px`;

        // Re-show tooltip if it was hidden while behind camera
        if (Annotation.activeAnnotation === this) {
            Annotation.tooltipDom.style.visibility = 'visible';
            Annotation.tooltipDom.style.opacity = '1';
        }

        // Position tooltip, clamped to viewport
        if (Annotation.activeAnnotation === this) {
            const tooltip = Annotation.tooltipDom;
            const margin = 8;
            const arrowOffset = 25;
            const tw = tooltip.offsetWidth;
            const th = tooltip.offsetHeight;
            const vw = window.innerWidth;
            const vh = window.innerHeight;

            // Default position: to the right of hotspot, vertically centered
            let left = screenPos.x + arrowOffset;
            let top = screenPos.y - th / 2;
            let flipped = false;

            // If tooltip overflows right edge, flip to left side of hotspot
            if (left + tw > vw - margin) {
                left = screenPos.x - arrowOffset - tw;
                flipped = true;
            }

            // Clamp horizontal
            left = Math.max(margin, Math.min(left, vw - tw - margin));

            // Clamp vertical
            top = Math.max(margin, Math.min(top, vh - th - margin));

            // Position arrow to point at the hotspot, clamped within the tooltip
            const arrowY = Math.max(16, Math.min(screenPos.y - top, th - 16));
            tooltip.style.setProperty('--arrow-top', `${arrowY}px`);

            tooltip.classList.toggle('arrow-right', !flipped);
            tooltip.classList.toggle('arrow-left', flipped);
            tooltip.style.transform = 'none';
            tooltip.style.left = `${left}px`;
            tooltip.style.top = `${top}px`;
        }
    }

    /**
     * Update 3D rotation and scale of hotspot planes.
     * @param {number} viewDepth - The view-space depth (positive distance along the camera's forward direction)
     * @private
     */
    _updateRotationAndScale(viewDepth: number) {
        // Copy camera rotation to align with view plane
        const cameraRotation = Annotation.camera.getRotation();
        this._updateHotspotTransform(this.entity, cameraRotation);

        // Calculate scale based on view depth to maintain constant screen size
        const scale = this._calculateScreenSpaceScale(viewDepth);
        this.entity.setLocalScale(scale, scale, scale);
    }

    /**
     * Update rotation of a single hotspot entity.
     * @param {Entity} hotspot - The hotspot entity to update
     * @param {Quat} cameraRotation - The camera's current rotation
     * @private
     */
    _updateHotspotTransform(hotspot: Entity, cameraRotation: Quat) {
        hotspot.setRotation(cameraRotation);
        hotspot.rotateLocal(90, 0, 0);
    }

    /**
     * Calculate scale factor to maintain constant screen-space size.
     * @param {number} viewDepth - The view-space depth (positive distance along the camera's forward direction)
     * @returns {number} The scale to apply to hotspot entities
     * @private
     */
    _calculateScreenSpaceScale(viewDepth: number) {
        // Use the canvas's CSS/client height instead of graphics device height
        const canvas = this.app.graphicsDevice.canvas;
        const screenHeight = canvas.clientHeight;

        // Use view-space depth (not Euclidean distance) to match the projection matrix
        const projMatrix = Annotation.camera.camera.projectionMatrix;
        const worldSize = (Annotation.hotspotSize / screenHeight) * (2 * viewDepth / projMatrix.data[5]);

        return worldSize;
    }
}
