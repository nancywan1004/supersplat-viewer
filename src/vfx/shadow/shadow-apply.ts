import {
    Script,
    Entity,
    Asset,
    Color,
    Layer,
    RenderTarget,
    Texture,
    PIXELFORMAT_RGBA8,
    BLEND_NORMAL,
    BLEND_NONE,
    BlendState,
    DepthState,
    StandardMaterial,
    drawQuadWithShader,
    createShaderFromCode,
    SEMANTIC_POSITION
} from 'playcanvas';
import type { Global } from '../../types';

/**
 * 与 Physics_Relighting_Demo 的 shadow-apply.mjs 完全一致的 shader：
 * shadowTex R 通道：1=受光，0=阴影。
 * blend = (1.0 - R) * intensity，Alpha Blend 黑色叠到屏幕。
 * 不做 threshold 截断——Demo 也没有。
 *
 * 【重要】投影不是我们算的：
 * - 我们不做任何阴影投影计算。shadowTex 的内容 100% 由 PlayCanvas 引擎在「阴影相机
 *   渲染接影面」时写入：接影面使用 LIT_SHADOW_CATCHER 材质，引擎采样光源的 shadow map 写出 R=0/1。
 * - 当该相机带 renderTarget（我们的 shadowMaskCamera）时，引擎在此 pass 里只合入
 *   平行光（directional）的 shadow map；平行光是否投射阴影由 postEffectSettings.shadow.enabled 统一控制。
 */
const shadowApplyVs = /* glsl */ `
    attribute vec2 vertex_position;
    void main(void) {
        gl_Position = vec4(vertex_position, 0.0, 1.0);
    }
`;

const shadowApplyFs = /* glsl */ `
    uniform sampler2D shadowTex;
    uniform float intensity;
    uniform float debugRt;
    void main(void) {
        float r = texelFetch(shadowTex, ivec2(gl_FragCoord.xy), 0).r;
        if (debugRt > 0.5) {
            gl_FragColor = vec4(r, r, r, 1.0);
        } else {
            float blend = 1.0 - r;
            gl_FragColor = vec4(0.0, 0.0, 0.0, blend * intensity);
        }
    }
`;

/**
 * ShadowApplyRt — 复刻 Physics_Relighting_Demo 的阴影系统。
 *
 * Demo 核心架构：
 * 1. ShadowCamera 是主相机的子实体（自动继承位置/旋转），只渲染接影层到 RT
 * 2. RT clearColor = 白色 [1,1,1,1]（R=1=不叠阴影），格式 RGBA8
 * 3. 接影面 castShadows=false, receiveShadows=true, material.shadowCatcher=true
 * 4. postrender 全屏 quad 画到 null（屏幕/backbuffer），NOT 画到 mainCam.renderTarget
 * 5. shader: blend = (1-R) * intensity，无 threshold
 */
class ShadowApplyRt extends Script {
    static scriptName = 'shadowApplyRt';

    global: Global | null = null;

    private _inited = false;
    private _shadowMaskCamera: Entity | null = null;
    private _shadowGeomEntity: Entity | null = null;
    private _shadowLayer: Layer | null = null;
    /** 用于 "Show shadow plane" 时把接影平面画在最上层 */
    private _debugLayer: Layer | null = null;
    /** 动态生成的 testSphere 列表 */
    private _testSpheres: Entity[] = [];
    private _sphereCounter = 0;

    /**
     * 在指定世界坐标生成一个 testSphere（castShadows=true）。
     * 由 UI 按钮通过事件触发。
     */
    spawnTestSphere(position: { x: number; y: number; z: number }, radius = 0.5) {
        const app = this.app;
        this._sphereCounter++;
        const name = `testSphere_${this._sphereCounter}`;
        const entity = new Entity(name);
        entity.setPosition(position.x, position.y, position.z);

        const mat = new StandardMaterial();
        mat.diffuse.set(0.85, 0.3, 0.25);
        mat.specular.set(0.3, 0.3, 0.3);
        mat.emissive.set(0.12, 0.04, 0.03);
        mat.emissiveIntensity = 1;
        mat.update();

        entity.addComponent('render', {
            type: 'sphere',
            castShadows: true,
            receiveShadows: false,
            material: mat
        });
        const worldLayer = app.scene.layers.getLayerByName('World') ?? app.scene.layers.layerList[0];
        if (entity.render && worldLayer) entity.render.layers = [worldLayer.id];
        entity.setLocalScale(radius * 2, radius * 2, radius * 2);
        app.root.addChild(entity);
        this._testSpheres.push(entity);
        (app as any).renderNextFrame = true;

        console.log(`[Shadow] spawnTestSphere: ${name} at (${position.x.toFixed(2)}, ${position.y.toFixed(2)}, ${position.z.toFixed(2)}), radius=${radius}`);
        return entity;
    }

    /** 清除所有动态生成的 testSphere */
    clearTestSpheres() {
        this._testSpheres.forEach((e) => {
            e.destroy();
        });
        this._testSpheres = [];
        (this.app as any).renderNextFrame = true;
        console.log('[Shadow] clearTestSpheres: all test spheres removed');
    }

    /** 动态生成的 testSplat 列表 */
    private _testSplats: Entity[] = [];
    private _splatCounter = 0;

    /**
     * 在指定世界坐标加载一个 gsplat（.sog/.ply/.splat 等）并添加到场景中。
     * 复制主高斯的 layers 和 unified 模式，确保与已有高斯正确混合渲染。
     */
    spawnTestSplat(url: string, position: { x: number; y: number; z: number }) {
        const app = this.app;
        this._splatCounter++;
        const name = `testSplat_${this._splatCounter}`;

        // 使用绝对 URL
        const absUrl = new URL(url, location.href).href;

        // 找到主高斯实体，获取其 layers 和 unified 配置
        const mainGsplat = app.root.findByName('gsplat') as Entity | null;
        const mainGsplatComp = mainGsplat?.gsplat;
        const mainLayers = mainGsplatComp?.layers ? [...mainGsplatComp.layers] : undefined;
        console.log('mainLayers', mainLayers);
        const mainUnified = mainGsplatComp?.unified ?? true;

        console.log(`[Shadow] spawnTestSplat: loading ${url}, mainLayers=${JSON.stringify(mainLayers)}, unified=${mainUnified}`);

        const asset = new Asset(name, 'gsplat', { url: absUrl, filename: url });
        app.assets.add(asset);

        asset.on('load', () => {
            const entity = new Entity(name);
            entity.setPosition(position.x, position.y, position.z);
            // 与主高斯一致：Z 轴翻转 180°
            entity.setLocalEulerAngles(0, 0, 180);

            // gsplat 组件参数：与主高斯一致
            const gsplatOpts: Record<string, any> = {
                unified: true,
                asset: asset,
                castShadows: true
            };
            // 如果主高斯有显式 layers，则复制
            if (mainLayers) {
                gsplatOpts.layers = mainLayers;
            }
            entity.addComponent('gsplat', gsplatOpts);

            app.root.addChild(entity);
            this._testSplats.push(entity);
            (app as any).renderNextFrame = true;

            console.log(`[Shadow] spawnTestSplat: ${name} loaded, layers=${JSON.stringify(entity.gsplat?.layers)}, unified=${entity.gsplat?.unified}, position=(${position.x.toFixed(2)}, ${position.y.toFixed(2)}, ${position.z.toFixed(2)})`);
        });

        asset.on('error', (err: string) => {
            console.error(`[Shadow] spawnTestSplat: failed to load ${url}`, err);
        });

        app.assets.load(asset);
    }

    /** 清除所有动态生成的 testSplat */
    clearTestSplats() {
        this._testSplats.forEach((e) => {
            e.destroy();
        });
        this._testSplats = [];
        (this.app as any).renderNextFrame = true;
        console.log('[Shadow] clearTestSplats: all test splats removed');
    }

    initialize() {
        const app = this.app as any;
        const global = app.__shadowApplyGlobal ?? this.global;
        const device = app.graphicsDevice;
        if (!global || !device) return;

        const anyApp = app as any;
        if (anyApp.__shadowMaskRtInited) {
            return;
        }
        anyApp.__shadowMaskRtInited = true;

        // ─── 层 ───
        const layers = app.scene.layers;
        let shadowLayer = layers.getLayerByName('ShadowMask') as Layer | null;
        if (!shadowLayer) {
            shadowLayer = new Layer({ name: 'ShadowMask' });
            layers.insert(shadowLayer, layers.layerList.length);
        }
        this._shadowLayer = shadowLayer;

        let debugLayer = layers.getLayerByName('ShadowDebug') as Layer | null;
        if (!debugLayer) {
            debugLayer = new Layer({ name: 'ShadowDebug' });
            layers.insert(debugLayer, layers.layerList.length);
        }
        this._debugLayer = debugLayer;

        // 参与阴影通道的光源必须把 ShadowMask 层加入 light.layers，阴影相机渲染该层时才会被用来打光并产生阴影。
        // 平行光（name='light'）
        const lightEntity = app.root.findByName('light') as Entity | null;
        if (lightEntity?.light) {
            const lightLayers = lightEntity.light.layers as number[];
            if (!lightLayers.includes(shadowLayer.id)) {
                lightEntity.light.layers = [...lightLayers, shadowLayer.id];
            }
        }
        const shadowSettings = global.settings.postEffectSettings.shadow as {
            debugVisual?: boolean; enabled?: boolean;
        } | undefined;
        const debugVisual = shadowSettings?.debugVisual === true;

        // ─── 接影几何 → 放到 ShadowMask 层 ───
        const shadowCatcherRoot = app.root.findByName('shadowCatcher') as Entity | null;
        const geomEntity = shadowCatcherRoot?.findByName('ShadowCatcherGeometry') as Entity | null;
        if (geomEntity && shadowLayer && debugLayer) {
            this._shadowGeomEntity = geomEntity;
            const layerIds = debugVisual ? [shadowLayer.id, debugLayer.id] : [shadowLayer.id];
            const setLayersOnHierarchy = (e: Entity) => {
                if (e.render) {
                    e.render.layers = layerIds;
                    e.render.receiveShadows = true;
                    e.render.castShadows = true;    // 同时投射阴影（自阴影）
                }
                e.children.forEach((c) => setLayersOnHierarchy(c as Entity));
            };
            setLayersOnHierarchy(geomEntity);
        }
        app.scene.layers.markDirty();

        const mainCamEntity = global.camera;
        const mainCamComp = mainCamEntity?.camera;
        if (!mainCamEntity || !mainCamComp) {
            return;
        }

        console.log('[Shadow] ShadowApplyRt init', {
            shadowLayerId: shadowLayer?.id,
            debugLayerId: debugLayer?.id,
            debugVisual,
            shadowEnabled: shadowSettings?.enabled,
            foundGeomEntity: !!geomEntity,
            mainCameraLayers: mainCamComp.layers,
            lightCastShadows: lightEntity?.light?.castShadows ?? 'N/A',
            lightLayers: lightEntity?.light?.layers
        });

        // ─── 阴影相机：作为主相机的子节点（与 Demo 完全一致） ───
        const shadowMaskCamera = new Entity('shadowMaskCamera');
        // clearColor = 白色 [1,1,1,1]，与 Demo 一致（R=1 = 不叠阴影）
        shadowMaskCamera.addComponent('camera', {
            clearColor: new Color(1, 1, 1, 1),
            projection: mainCamComp.projection,
            fov: mainCamComp.fov,
            nearClip: mainCamComp.nearClip,
            farClip: mainCamComp.farClip
        });
        const smCamComp = shadowMaskCamera.camera!;
        smCamComp.layers = [shadowLayer.id];
        // 确保阴影相机在主相机之前渲染（低 priority = 先渲染）
        smCamComp.priority = -1;

        // 与 Demo 一致：RT 格式 RGBA8
        const shadowTex = new Texture(device, {
            name: 'shadowMaskTex',
            width: device.width,
            height: device.height,
            format: PIXELFORMAT_RGBA8,
            mipmaps: false
        });
        const shadowRt = new RenderTarget({
            colorBuffer: shadowTex,
            depth: true
        });
        smCamComp.renderTarget = shadowRt;

        // 放在 app.root 下（避免 CameraFrame 干扰子相机的 renderTarget）
        // 位置/旋转在 update() 中与主相机同步
        shadowMaskCamera.setPosition(mainCamEntity.getPosition());
        shadowMaskCamera.setRotation(mainCamEntity.getRotation());
        app.root.addChild(shadowMaskCamera);

        this._shadowMaskCamera = shadowMaskCamera;
        console.log('[Shadow] shadowMaskCamera created under app.root', {
            cameraLayers: smCamComp.layers,
            renderTarget: !!smCamComp.renderTarget
        });

        // ─── Shader ───
        const shader = createShaderFromCode(
            device,
            shadowApplyVs,
            shadowApplyFs,
            'shadowApply',
            { vertex_position: SEMANTIC_POSITION }
        );

        // ─── postrender：与 Demo 完全一致 ───
        let _postrenderCount = 0;
        app.on('postrender', () => {
            _postrenderCount++;
            const shadowSettingsNow = (global.settings.postEffectSettings.shadow || {}) as {
                enabled?: boolean;
                darken?: number;
                debugRt?: boolean;
                debugVisual?: boolean;
            };
            if (!shadowSettingsNow.enabled) {
                if (_postrenderCount <= 3) {
                    console.log('[Shadow] postrender skipped (shadow.enabled is false).');
                }
                return;
            }
            // debugVisual 时不叠阴影（此时材质已切换为 debugMaterial，RT 无意义）
            if (shadowSettingsNow.debugVisual) {
                return;
            }

            if (shadowRt.width !== device.width || shadowRt.height !== device.height) {
                shadowRt.resize(device.width, device.height);
            }

            // intensity = 1 - darken：darken=0 最暗，darken=1 不压暗
            const darken = Math.max(0, Math.min(1, Number(shadowSettingsNow.darken ?? 0)));
            const intensity = 1 - darken;
            const debugRt = shadowSettingsNow.debugRt === true ? 1 : 0;

            // shadowTex 由引擎写入（仅平行光参与），此处只做 (1-R)*intensity 叠黑，无自算投影
            device.scope.resolve('shadowTex')?.setValue(shadowTex);
            device.scope.resolve('intensity')?.setValue(intensity);
            device.scope.resolve('debugRt')?.setValue(debugRt);

            if (debugRt > 0.5) {
                device.setBlendState(BlendState.NOBLEND);
            } else {
                device.setBlendState(BlendState.ALPHABLEND);
            }
            device.setDepthState(DepthState.NODEPTH);
            drawQuadWithShader(device, null, shader);

            if (_postrenderCount <= 3 || _postrenderCount % 300 === 0) {
                console.log('[Shadow] postrender applied', {
                    frame: _postrenderCount,
                    darken,
                    intensity,
                    debugRt,
                    rtSize: `${shadowRt.width}x${shadowRt.height}`,
                    deviceSize: `${device.width}x${device.height}`
                });
            }
        });

        // ─── 监听 UI 事件：生成/清除 testSphere / testSplat ───
        const events = global.events;
        events.on('shadow:spawnSphere', (data: { x: number; y: number; z: number; radius?: number }) => {
            this.spawnTestSphere(data, data.radius);
        });
        events.on('shadow:clearSpheres', () => {
            this.clearTestSpheres();
        });
        events.on('shadow:spawnSplat', (data: { url: string; x: number; y: number; z: number }) => {
            this.spawnTestSplat(data.url, data);
        });
        events.on('shadow:clearSplats', () => {
            this.clearTestSplats();
        });

        this._inited = true;
    }

    private _debugLogTicks = 0;
    private _lastDebugVisual = false;
    /** debugVisual 时使用的半透明绿色材质 */
    private _debugMaterial: StandardMaterial | null = null;
    /** 缓存每个 meshInstance 的原始 ShadowMat 引用 */
    private _originalMaterials: WeakMap<object, object> = new WeakMap();

    private _getDebugMaterial(): StandardMaterial {
        if (!this._debugMaterial) {
            const mat = new StandardMaterial();
            mat.diffuse.set(0.1, 0.8, 0.3);
            mat.emissive.set(0, 0.3, 0.1);
            mat.specular.set(0, 0, 0);
            mat.opacity = 0.35;
            mat.blendType = BLEND_NORMAL;
            mat.depthWrite = false;
            mat.depthTest = true;
            mat.useLighting = false;
            mat.useSkybox = false;
            mat.useFog = false;
            // 注意：不设 shadowCatcher，这样主相机渲染时正常显示半透明绿色
            mat.update();
            this._debugMaterial = mat;
        }
        return this._debugMaterial;
    }

    update() {
        if (!this._inited || !this.global?.camera) return;
        const shadowLayer = this._shadowLayer;
        const shadowSettings = this.global.settings.postEffectSettings?.shadow as {
            debugVisual?: boolean; enabled?: boolean; castShadows?: boolean;
        } | undefined;

        const debugVisual = shadowSettings?.debugVisual === true;
        const meshCastShadows = shadowSettings?.castShadows !== false;

        // ─── 接影几何层 + 材质管理 ───
        if (shadowLayer && this._shadowGeomEntity && this._debugLayer) {
            const debugChanged = debugVisual !== this._lastDebugVisual;
            this._lastDebugVisual = debugVisual;

            // 层配置：debugVisual 时同时在 ShadowMask（阴影相机用）和 ShadowDebug（主相机用）上
            // 非 debugVisual 时只在 ShadowMask 上
            const layerIds = debugVisual
                ? [shadowLayer.id, this._debugLayer.id]
                : [shadowLayer.id];

            const debugMat = debugVisual ? this._getDebugMaterial() : null;

            const visit = (e: Entity) => {
                if (e.render) {
                    e.render.layers = layerIds;
                    e.render.receiveShadows = true;
                    e.render.castShadows = meshCastShadows;

                    // 材质切换：
                    // debugVisual ON → 使用 debugMaterial（半透明绿色，无 shadowCatcher）
                    //   这样主相机渲染 ShadowDebug 层时看到绿色接影几何
                    //   代价：阴影相机也渲染 debugMaterial 而非 ShadowMat → shadow RT 不含阴影信息
                    //   可接受：debugVisual 是调试用途，不需要正确的阴影
                    // debugVisual OFF → 恢复 ShadowMat（shadowCatcher=true）
                    if (debugChanged) {
                        e.render.meshInstances?.forEach((mi: any) => {
                            if (debugVisual && debugMat) {
                                // 保存原始 ShadowMat
                                if (!this._originalMaterials.has(mi)) {
                                    this._originalMaterials.set(mi, mi.material);
                                }
                                mi.material = debugMat;
                            } else {
                                // 恢复原始 ShadowMat
                                const orig = this._originalMaterials.get(mi);
                                if (orig) {
                                    mi.material = orig;
                                }
                            }
                        });
                    }
                }
                e.children.forEach((c) => visit(c as Entity));
            };
            visit(this._shadowGeomEntity);
        }

        // ─── testSphere 层管理：确保不在 ShadowMask 层 ───
        if (shadowLayer) {
            this._testSpheres.forEach((sphere) => {
                if (sphere.render) {
                    const worldLayer = this.app.scene.layers.getLayerByName('World') ?? this.app.scene.layers.layerList[0];
                    const defaultLayerId = worldLayer?.id ?? this.app.scene.layers.layerList[0]?.id ?? 0;
                    const layers = (sphere.render.layers as number[]) ?? [defaultLayerId];
                    if (layers.includes(shadowLayer.id)) {
                        sphere.render.layers = layers.filter((id: number) => id !== shadowLayer.id);
                        if (sphere.render.layers.length === 0) {
                            sphere.render.layers = [defaultLayerId];
                        }
                    }
                }
            });
        }

        // ─── debugVisual 时主相机渲染 ShadowDebug 层 ───
        if (this._debugLayer) {
            const mainCamComp = this.global.camera?.camera;
            if (mainCamComp) {
                const hasDebug = mainCamComp.layers.indexOf(this._debugLayer.id) >= 0;
                if (debugVisual && !hasDebug) {
                    mainCamComp.layers = [...mainCamComp.layers, this._debugLayer.id];
                } else if (!debugVisual && hasDebug) {
                    mainCamComp.layers = mainCamComp.layers.filter((id: number) => id !== this._debugLayer!.id);
                }
            }
        }

        // ─── 同步阴影相机 ───
        if (this._shadowMaskCamera && this.global.camera) {
            const mainCamEntity = this.global.camera;
            this._shadowMaskCamera.setPosition(mainCamEntity.getPosition());
            this._shadowMaskCamera.setRotation(mainCamEntity.getRotation());
            if (this._shadowMaskCamera.camera && mainCamEntity.camera) {
                const smCam = this._shadowMaskCamera.camera;
                const mainCam = mainCamEntity.camera;
                if (smCam.fov !== mainCam.fov) smCam.fov = mainCam.fov;
                if (smCam.nearClip !== mainCam.nearClip) smCam.nearClip = mainCam.nearClip;
                if (smCam.farClip !== mainCam.farClip) smCam.farClip = mainCam.farClip;
            }
        }

        this._debugLogTicks++;
        // if (this._debugLogTicks <= 3 || this._debugLogTicks % 300 === 0) {
        //     const smCam = this._shadowMaskCamera?.camera;
        //     console.log('[Shadow] update', {
        //         tick: this._debugLogTicks,
        //         debugVisual,
        //         shadowEnabled: shadowSettings?.enabled,
        //         geomLayers: this._shadowGeomEntity?.render?.layers,
        //         geomMeshCount: this._shadowGeomEntity?.render?.meshInstances?.length ?? 0,
        //         smCamEnabled: this._shadowMaskCamera?.enabled,
        //         smCamPriority: smCam?.priority,
        //         smCamRT: !!smCam?.renderTarget,
        //         smCamLayers: smCam?.layers,
        //         testSphereCount: this._testSpheres.length
        //     });
        // }
    }
}

export { ShadowApplyRt };
