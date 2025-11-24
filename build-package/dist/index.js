import { Vec3, Script, Color, Mesh, PlaneGeometry, Texture, FILTER_LINEAR, PIXELFORMAT_RGBA8, StandardMaterial, BlendState, BLENDEQUATION_ADD, BLENDMODE_SRC_ALPHA, BLENDMODE_ONE_MINUS_SRC_ALPHA, BLENDMODE_ONE, CULLFACE_NONE, Entity, MeshInstance, Layer, Mat4, Quat, math, Vec2, Pose, OrbitController as OrbitController$1, Vec4, Picker as Picker$1, KeyboardMouseSource, MultiTouchSource, DualGestureSource, GamepadSource, InputFrame, PROJECTION_PERSPECTIVE, ShaderChunks, MiniStats, BoundingBox, CameraFrame, TONEMAP_NEUTRAL, TONEMAP_ACES2, TONEMAP_ACES, TONEMAP_HEJL, TONEMAP_FILMIC, TONEMAP_LINEAR, TONEMAP_NONE, PIXELFORMAT_RGBA16F, PIXELFORMAT_RGBA32F, RenderTarget } from 'playcanvas';

// clamp the vertices of the hotspot so it is never clipped by the near or far plane
const depthClamp = `
    float f = gl_Position.z / gl_Position.w;
    if (f > 1.0) {
        gl_Position.z = gl_Position.w;
    } else if (f < -1.0) {
        gl_Position.z = -gl_Position.w;
    }
`;
const vec$1 = new Vec3();
/**
 * A script for creating interactive 3D annotations in a scene. Each annotation consists of:
 *
 * - A 3D hotspot that maintains constant screen-space size. The hotspot is rendered with muted
 * appearance when obstructed by geometry but is still clickable. The hotspot relies on an
 * invisible DOM element that matches the hotspot's size and position to detect clicks.
 * - An annotation panel that shows title and description text.
 */
class Annotation extends Script {
    static scriptName = 'annotation';
    static hotspotSize = 25;
    static hotspotColor = new Color(0.8, 0.8, 0.8);
    static hoverColor = new Color(1.0, 0.4, 0.0);
    static parentDom = null;
    static styleSheet = null;
    static camera = null;
    static tooltipDom = null;
    static titleDom = null;
    static textDom = null;
    static layers = [];
    static mesh = null;
    static activeAnnotation = null;
    static hoverAnnotation = null;
    static opacity = 1.0;
    /**
     * @attribute
     */
    label;
    /**
     * @attribute
     */
    title;
    /**
     * @attribute
     */
    text;
    /**
     * @private
     */
    hotspotDom = null;
    /**
     * @private
     */
    texture = null;
    /**
     * @private
     */
    materials = [];
    /**
     * Injects required CSS styles into the document.
     * @param {number} size - The size of the hotspot in screen pixels.
     * @private
     */
    static _injectStyles(size) {
        const css = `
            .pc-annotation {
                display: block;
                position: absolute;
                background-color: rgba(0, 0, 0, 0.8);
                color: white;
                padding: 8px;
                border-radius: 4px;
                font-size: 14px;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
                pointer-events: none;
                max-width: 200px;
                word-wrap: break-word;
                overflow-x: visible;
                white-space: normal;
                width: fit-content;
                opacity: 0;
                transition: opacity 0.2s ease-in-out;
                visibility: hidden;
                transform: translate(25px, -50%);
            }

            .pc-annotation-title {
                font-weight: bold;
                margin-bottom: 4px;
            }

            /* Add a little triangular arrow on the left edge of the tooltip */
            .pc-annotation::before {
                content: "";
                position: absolute;
                left: -8px;
                top: 50%;
                transform: translateY(-50%);
                width: 0;
                height: 0;
                border-top: 8px solid transparent;
                border-bottom: 8px solid transparent;
                border-right: 8px solid rgba(0, 0, 0, 0.8);
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
    static _initializeStatic(app) {
        if (Annotation.styleSheet) {
            return;
        }
        Annotation._injectStyles(Annotation.hotspotSize);
        if (Annotation.parentDom === null) {
            Annotation.parentDom = document.body;
        }
        const { layers } = app.scene;
        const worldLayer = layers.getLayerByName('World');
        const createLayer = (name, semitrans) => {
            const layer = new Layer({ name: name });
            const idx = semitrans ? layers.getTransparentIndex(worldLayer) : layers.getOpaqueIndex(worldLayer);
            layers.insert(layer, idx + 1);
            return layer;
        };
        Annotation.layers = [
            createLayer('HotspotBase', false),
            createLayer('HotspotOverlay', true)
        ];
        if (Annotation.camera === null) {
            Annotation.camera = app.root.findComponent('camera').entity;
        }
        Annotation.camera.camera.layers = [
            ...Annotation.camera.camera.layers,
            ...Annotation.layers.map(layer => layer.id)
        ];
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
        Annotation.parentDom.appendChild(Annotation.tooltipDom);
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
    static _createHotspotTexture(app, label, size = 64, borderWidth = 6) {
        // Create canvas for hotspot texture
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        // First clear with stroke color at zero alpha
        ctx.fillStyle = 'white';
        ctx.globalAlpha = 0;
        ctx.fillRect(0, 0, size, size);
        ctx.globalAlpha = 1.0;
        // Draw dark circle with light border
        const centerX = size / 2;
        const centerY = size / 2;
        const radius = (size / 2) - 4; // Leave space for border
        // Draw main circle
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
        ctx.fillStyle = 'black';
        ctx.fill();
        // Draw border
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
        ctx.lineWidth = borderWidth;
        ctx.strokeStyle = 'white';
        ctx.stroke();
        // Draw text
        ctx.font = 'bold 32px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'white';
        ctx.fillText(label, Math.floor(canvas.width / 2), Math.floor(canvas.height / 2) + 1);
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
    static _createHotspotMaterial(texture, { opacity = 1, depthTest = true, depthWrite = true } = {}) {
        const material = new StandardMaterial();
        // Base properties
        material.diffuse = Color.BLACK;
        material.emissive.copy(Annotation.hotspotColor);
        material.emissiveMap = texture;
        material.opacityMap = texture;
        // Alpha properties
        material.opacity = opacity;
        material.alphaTest = 0.01;
        material.blendState = new BlendState(true, BLENDEQUATION_ADD, BLENDMODE_SRC_ALPHA, BLENDMODE_ONE_MINUS_SRC_ALPHA, BLENDEQUATION_ADD, BLENDMODE_ONE, BLENDMODE_ONE);
        // Depth properties
        material.depthTest = depthTest;
        material.depthWrite = depthWrite;
        // Rendering properties
        material.cull = CULLFACE_NONE;
        material.useLighting = false;
        material.shaderChunks.glsl.add({
            'litUserMainEndVS': depthClamp
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
                depthWrite: true
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
        // Create hotspot dom
        this.hotspotDom = document.createElement('div');
        this.hotspotDom.className = 'pc-annotation-hotspot';
        // Add click handlers
        this.hotspotDom.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showTooltip();
        });
        const leave = () => {
            if (Annotation.hoverAnnotation === this) {
                Annotation.hoverAnnotation = null;
                this.setHover(false);
            }
        };
        const enter = () => {
            if (Annotation.hoverAnnotation !== null) {
                Annotation.hoverAnnotation.setHover(false);
            }
            Annotation.hoverAnnotation = this;
            this.setHover(true);
        };
        this.hotspotDom.addEventListener('pointerenter', enter);
        this.hotspotDom.addEventListener('pointerleave', leave);
        document.addEventListener('click', () => {
            this.hideTooltip();
        });
        Annotation.parentDom.appendChild(this.hotspotDom);
        // Clean up on entity destruction
        this.on('destroy', () => {
            this.hotspotDom.remove();
            if (Annotation.activeAnnotation === this) {
                this.hideTooltip();
            }
            this.materials.forEach(mat => mat.destroy());
            this.materials = [];
            this.texture.destroy();
            this.texture = null;
        });
        this.app.on('prerender', () => {
            if (!Annotation.camera)
                return;
            const position = this.entity.getPosition();
            const screenPos = Annotation.camera.camera.worldToScreen(position);
            const { viewMatrix } = Annotation.camera.camera;
            viewMatrix.transformPoint(position, vec$1);
            if (vec$1.z >= 0) {
                this._hideElements();
                return;
            }
            this._updatePositions(screenPos);
            this._updateRotationAndScale();
            // update material opacity and also directly on the uniform so we
            // can avoid a full material update
            this.materials[0].opacity = Annotation.opacity;
            this.materials[1].opacity = 0.25 * Annotation.opacity;
            this.materials[0].setParameter('material_opacity', Annotation.opacity);
            this.materials[1].setParameter('material_opacity', 0.25 * Annotation.opacity);
        });
    }
    /**
     * Set the hover state of the annotation.
     * @param hover - Whether the annotation is hovered
     * @private
     */
    setHover(hover) {
        this.materials.forEach((material) => {
            material.emissive.copy(hover ? Annotation.hoverColor : Annotation.hotspotColor);
            material.update();
        });
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
        this.fire('show', this);
    }
    /**
     * @private
     */
    hideTooltip() {
        Annotation.activeAnnotation = null;
        Annotation.tooltipDom.style.opacity = '0';
        // Wait for fade out before hiding
        setTimeout(() => {
            if (Annotation.tooltipDom.style.opacity === '0') {
                Annotation.tooltipDom.style.visibility = 'hidden';
            }
            this.fire('hide');
        }, 200); // Match the transition duration
    }
    /**
     * Hide all elements when annotation is behind camera.
     * @private
     */
    _hideElements() {
        this.hotspotDom.style.display = 'none';
        if (Annotation.activeAnnotation === this) {
            if (Annotation.tooltipDom.style.visibility !== 'hidden') {
                this.hideTooltip();
            }
        }
    }
    /**
     * Update screen-space positions of HTML elements.
     * @param {Vec3} screenPos - Screen coordinate
     * @private
     */
    _updatePositions(screenPos) {
        // Show and position hotspot
        this.hotspotDom.style.display = 'block';
        this.hotspotDom.style.left = `${screenPos.x}px`;
        this.hotspotDom.style.top = `${screenPos.y}px`;
        // Position tooltip
        if (Annotation.activeAnnotation === this) {
            Annotation.tooltipDom.style.left = `${screenPos.x}px`;
            Annotation.tooltipDom.style.top = `${screenPos.y}px`;
        }
    }
    /**
     * Update 3D rotation and scale of hotspot planes.
     * @private
     */
    _updateRotationAndScale() {
        // Copy camera rotation to align with view plane
        const cameraRotation = Annotation.camera.getRotation();
        this._updateHotspotTransform(this.entity, cameraRotation);
        // Calculate scale based on distance to maintain constant screen size
        const scale = this._calculateScreenSpaceScale();
        this.entity.setLocalScale(scale, scale, scale);
    }
    /**
     * Update rotation of a single hotspot entity.
     * @param {Entity} hotspot - The hotspot entity to update
     * @param {Quat} cameraRotation - The camera's current rotation
     * @private
     */
    _updateHotspotTransform(hotspot, cameraRotation) {
        hotspot.setRotation(cameraRotation);
        hotspot.rotateLocal(90, 0, 0);
    }
    /**
     * Calculate scale factor to maintain constant screen-space size.
     * @returns {number} The scale to apply to hotspot entities
     * @private
     */
    _calculateScreenSpaceScale() {
        const cameraPos = Annotation.camera.getPosition();
        const toAnnotation = this.entity.getPosition().sub(cameraPos);
        const distance = toAnnotation.length();
        // Use the canvas's CSS/client height instead of graphics device height
        const canvas = this.app.graphicsDevice.canvas;
        const screenHeight = canvas.clientHeight;
        // Get the camera's projection matrix vertical scale factor
        const projMatrix = Annotation.camera.camera.projectionMatrix;
        const worldSize = (Annotation.hotspotSize / screenHeight) * (2 * distance / projMatrix.data[5]);
        return worldSize;
    }
}

class Annotations {
    annotations;
    parentDom;
    constructor(global, hasCameraFrame) {
        // create dom parent
        const parentDom = document.createElement('div');
        parentDom.id = 'annotations';
        Annotation.parentDom = parentDom;
        document.querySelector('#ui').appendChild(parentDom);
        global.events.on('controlsHidden:changed', (value) => {
            parentDom.style.display = value ? 'none' : 'block';
            Annotation.opacity = value ? 0.0 : 1.0;
            global.app.renderNextFrame = true;
        });
        this.annotations = global.settings.annotations;
        this.parentDom = parentDom;
        if (hasCameraFrame) {
            Annotation.hotspotColor.gamma();
            Annotation.hoverColor.gamma();
        }
        // create annotation entities
        const parent = global.app.root;
        for (let i = 0; i < this.annotations.length; i++) {
            const ann = this.annotations[i];
            const entity = new Entity();
            entity.addComponent('script');
            entity.script.create(Annotation);
            const script = entity.script;
            script.annotation.label = (i + 1).toString();
            script.annotation.title = ann.title;
            script.annotation.text = ann.text;
            entity.setPosition(ann.position[0], ann.position[1], ann.position[2]);
            parent.addChild(entity);
            // handle an annotation being activated/shown
            script.annotation.on('show', () => {
                global.events.fire('annotation.activate', ann);
            });
            // re-render if hover state changes
            script.annotation.on('hover', (hover) => {
                global.app.renderNextFrame = true;
            });
        }
    }
}

/**
 * Creates a rotation animation track
 *
 * @param position - Starting location of the camera.
 * @param target - Target point around which to rotate
 * @param fov - The camera field of view.
 * @param keys - The number of keys in the animation.
 * @param duration - The duration of the animation in seconds.
 * @returns - The animation track object containing position and target keyframes.
 */
const createRotateTrack = (position, target, fov, keys = 12, duration = 20) => {
    const times = new Array(keys).fill(0).map((_, i) => i / keys * duration);
    const positions = [];
    const targets = [];
    const fovs = new Array(keys).fill(fov);
    const mat = new Mat4();
    const vec = new Vec3();
    const dif = new Vec3(position.x - target.x, position.y - target.y, position.z - target.z);
    for (let i = 0; i < keys; ++i) {
        mat.setFromEulerAngles(0, -i / keys * 360, 0);
        mat.transformPoint(dif, vec);
        positions.push(target.x + vec.x);
        positions.push(target.y + vec.y);
        positions.push(target.z + vec.z);
        targets.push(target.x);
        targets.push(target.y);
        targets.push(target.z);
    }
    return {
        name: 'rotate',
        duration,
        frameRate: 1,
        loopMode: 'repeat',
        interpolation: 'spline',
        smoothness: 1,
        keyframes: {
            times,
            values: {
                position: positions,
                target: targets,
                fov: fovs
            }
        }
    };
};

class CubicSpline {
    // control times
    times;
    // control data: in-tangent, point, out-tangent
    knots;
    // dimension of the knot points
    dim;
    constructor(times, knots) {
        this.times = times;
        this.knots = knots;
        this.dim = knots.length / times.length / 3;
    }
    evaluate(time, result) {
        const { times } = this;
        const last = times.length - 1;
        if (time <= times[0]) {
            this.getKnot(0, result);
        }
        else if (time >= times[last]) {
            this.getKnot(last, result);
        }
        else {
            let seg = 0;
            while (time >= times[seg + 1]) {
                seg++;
            }
            this.evaluateSegment(seg, (time - times[seg]) / (times[seg + 1] - times[seg]), result);
        }
    }
    getKnot(index, result) {
        const { knots, dim } = this;
        const idx = index * 3 * dim;
        for (let i = 0; i < dim; ++i) {
            result[i] = knots[idx + i * 3 + 1];
        }
    }
    // evaluate the spline segment at the given normalized time t
    evaluateSegment(segment, t, result) {
        const { knots, dim } = this;
        const t2 = t * t;
        const twot = t + t;
        const omt = 1 - t;
        const omt2 = omt * omt;
        let idx = segment * dim * 3; // each knot has 3 values: tangent in, value, tangent out
        for (let i = 0; i < dim; ++i) {
            const p0 = knots[idx + 1]; // p0
            const m0 = knots[idx + 2]; // outgoing tangent
            const m1 = knots[idx + dim * 3]; // incoming tangent
            const p1 = knots[idx + dim * 3 + 1]; // p1
            idx += 3;
            result[i] =
                p0 * ((1 + twot) * omt2) +
                    m0 * (t * omt2) +
                    p1 * (t2 * (3 - twot)) +
                    m1 * (t2 * (t - 1));
        }
    }
    // calculate cubic spline knots from points
    // times: time values for each control point
    // points: control point values to be interpolated (n dimensional)
    // smoothness: 0 = linear, 1 = smooth
    static calcKnots(times, points, smoothness) {
        const n = times.length;
        const dim = points.length / n;
        const knots = new Array(n * dim * 3);
        for (let i = 0; i < n; i++) {
            const t = times[i];
            for (let j = 0; j < dim; j++) {
                const idx = i * dim + j;
                const p = points[idx];
                let tangent;
                if (i === 0) {
                    tangent = (points[idx + dim] - p) / (times[i + 1] - t);
                }
                else if (i === n - 1) {
                    tangent = (p - points[idx - dim]) / (t - times[i - 1]);
                }
                else {
                    tangent = (points[idx + dim] - points[idx - dim]) / (times[i + 1] - times[i - 1]);
                }
                // convert to derivatives w.r.t normalized segment parameter
                const inScale = i > 0 ? (times[i] - times[i - 1]) : (times[1] - times[0]);
                const outScale = i < n - 1 ? (times[i + 1] - times[i]) : (times[i] - times[i - 1]);
                knots[idx * 3] = tangent * inScale * smoothness;
                knots[idx * 3 + 1] = p;
                knots[idx * 3 + 2] = tangent * outScale * smoothness;
            }
        }
        return knots;
    }
    static fromPoints(times, points, smoothness = 1) {
        return new CubicSpline(times, CubicSpline.calcKnots(times, points, smoothness));
    }
    // create a looping spline by duplicating animation points at the end and beginning
    static fromPointsLooping(length, times, points, smoothness = 1) {
        if (times.length < 2) {
            return CubicSpline.fromPoints(times, points);
        }
        const dim = points.length / times.length;
        const newTimes = times.slice();
        const newPoints = points.slice();
        // append first two points
        newTimes.push(length + times[0], length + times[1]);
        newPoints.push(...points.slice(0, dim * 2));
        // prepend last two points
        newTimes.splice(0, 0, times[times.length - 2] - length, times[times.length - 1] - length);
        newPoints.splice(0, 0, ...points.slice(points.length - dim * 2));
        return CubicSpline.fromPoints(newTimes, newPoints, smoothness);
    }
}

/**
 * Damping function to smooth out transitions.
 *
 * @param damping - Damping factor (0 < damping < 1).
 * @param dt - Delta time in seconds.
 * @returns - Damping factor adjusted for the delta time.
 */
/**
 * Smoother step function.
 * Ken Perlin's improved smoothstep.
 *
 * @param x - Input value in the range [0, 1].
 * @returns - Output value in the range [0, 1].
 */
const smootherStep = (x) => x * x * x * (x * (x * 6 - 15) + 10);
/**
 * Modulus function that handles negative values correctly.
 *
 * @param n - The number to be modulated.
 * @param m - The modulus value.
 * @returns - The result of n mod m, adjusted to be non-negative.
 */
const mod = (n, m) => ((n % m) + m) % m;
const nearlyEquals = (a, b, epsilon = 1e-4) => {
    return !a.some((v, i) => Math.abs(v - b[i]) >= epsilon);
};
const vecToAngles = (result, vec) => {
    const radToDeg = 180 / Math.PI;
    result.x = Math.asin(vec.y) * radToDeg;
    result.y = Math.atan2(-vec.x, -vec.z) * radToDeg;
    result.z = 0;
    return result;
};

// track an animation cursor with support for repeat and ping-pong loop modes
class AnimCursor {
    duration = 0;
    loopMode = 'none';
    timer = 0;
    cursor = 0;
    constructor(duration, loopMode) {
        this.reset(duration, loopMode);
    }
    update(deltaTime) {
        // update animation timer
        this.timer += deltaTime;
        // update the track cursor
        this.cursor += deltaTime;
        if (this.cursor >= this.duration) {
            switch (this.loopMode) {
                case 'none':
                    this.cursor = this.duration;
                    break;
                case 'repeat':
                    this.cursor %= this.duration;
                    break;
                case 'pingpong':
                    this.cursor %= (this.duration * 2);
                    break;
            }
        }
    }
    reset(duration, loopMode) {
        this.duration = duration;
        this.loopMode = loopMode;
        this.timer = 0;
        this.cursor = 0;
    }
    set value(value) {
        this.cursor = mod(value, this.duration);
    }
    get value() {
        return this.cursor > this.duration ? this.duration - this.cursor : this.cursor;
    }
}

// manage the state of a camera animation track
class AnimState {
    spline;
    cursor = new AnimCursor(0, 'none');
    frameRate;
    result = [];
    position = new Vec3();
    target = new Vec3();
    constructor(spline, duration, loopMode, frameRate) {
        this.spline = spline;
        this.cursor.reset(duration, loopMode);
        this.frameRate = frameRate;
    }
    // update given delta time
    update(dt) {
        const { cursor, result, spline, frameRate, position, target } = this;
        // update the animation cursor
        cursor.update(dt);
        // evaluate the spline
        spline.evaluate(cursor.value * frameRate, result);
        if (result.every(isFinite)) {
            position.set(result[0], result[1], result[2]);
            target.set(result[3], result[4], result[5]);
        }
    }
    // construct an animation from a settings track
    static fromTrack(track) {
        const { keyframes, duration, frameRate, loopMode, smoothness } = track;
        const { times, values } = keyframes;
        const { position, target } = values;
        // construct the points array containing position and target
        const points = [];
        for (let i = 0; i < times.length; i++) {
            points.push(position[i * 3], position[i * 3 + 1], position[i * 3 + 2]);
            points.push(target[i * 3], target[i * 3 + 1], target[i * 3 + 2]);
        }
        const extra = (duration === times[times.length - 1] / frameRate) ? 1 : 0;
        const spline = CubicSpline.fromPointsLooping((duration + extra) * frameRate, times, points, smoothness);
        return new AnimState(spline, duration, loopMode, frameRate);
    }
}

class AnimController {
    animState;
    constructor(animTrack) {
        this.animState = AnimState.fromTrack(animTrack);
        this.animState.update(0);
    }
    onEnter(camera) {
        // snap camera to start position
        camera.look(this.animState.position, this.animState.target);
    }
    update(deltaTime, inputFrame, camera) {
        this.animState.update(deltaTime);
        // update camera pose
        camera.look(this.animState.position, this.animState.target);
        // ignore input
        inputFrame.read();
    }
    onExit(camera) {
    }
}

const rotation$1 = new Quat();
const avec = new Vec3();
const bvec = new Vec3();
class Camera {
    position = new Vec3();
    angles = new Vec3();
    distance = 1;
    fov = 65;
    constructor(other) {
        if (other) {
            this.copy(other);
        }
    }
    copy(source) {
        this.position.copy(source.position);
        this.angles.copy(source.angles);
        this.distance = source.distance;
        this.fov = source.fov;
    }
    lerp(a, b, t) {
        a.calcFocusPoint(avec);
        b.calcFocusPoint(bvec);
        this.position.lerp(a.position, b.position, t);
        avec.lerp(avec, bvec, t).sub(this.position);
        this.distance = avec.length();
        vecToAngles(this.angles, avec.mulScalar(1.0 / this.distance));
        // Preserve roll by interpolating it separately
        // vecToAngles only calculates pitch and yaw, setting roll to 0
        this.angles.z = math.lerp(a.angles.z, b.angles.z, t);
        this.fov = math.lerp(a.fov, b.fov, t);
    }
    look(from, to) {
        this.position.copy(from);
        this.distance = from.distance(to);
        const dir = avec.sub2(to, from).normalize();
        vecToAngles(this.angles, dir);
    }
    calcFocusPoint(result) {
        rotation$1.setFromEulerAngles(this.angles)
            .transformVector(Vec3.FORWARD, result)
            .mulScalar(this.distance)
            .add(this.position);
    }
}

const angles = new Vec3();
const rotation = new Quat();
const forward = new Vec3();
const right = new Vec3();
const up = new Vec3();
const offset = new Vec3();
// Damping helper function
const damp = (damping, dt) => {
    return 1 - Math.pow(damping, dt * 60);
};
class FlyController {
    _targetPose;
    _pose;
    rotateDamping = 0.1; // Lower damping for more responsive rotation (was 0.9)
    moveDamping = 0.9;
    pitchRange = new Vec2(-90, 90);
    constructor() {
        this._targetPose = new Pose();
        this._pose = new Pose();
    }
    onEnter(camera) {
        this._targetPose.set(camera.position, camera.angles, camera.distance);
        this._pose.copy(this._targetPose);
    }
    update(deltaTime, inputFrame, camera) {
        const { move, rotate } = inputFrame.read();
        // Apply rotation with roll support
        // rotate[0] = mouse/touch X (yaw)
        // rotate[1] = mouse/touch Y (pitch)
        // rotate[2] = Q/E keys (roll)
        angles.set(-rotate[1], -rotate[0], rotate[2]);
        this._targetPose.rotate(angles);
        // Clamp pitch
        this._targetPose.angles.x = math.clamp(this._targetPose.angles.x, this.pitchRange.x, this.pitchRange.y);
        // Apply movement in local space
        rotation.setFromEulerAngles(this._pose.angles);
        rotation.transformVector(Vec3.FORWARD, forward);
        rotation.transformVector(Vec3.RIGHT, right);
        rotation.transformVector(Vec3.UP, up);
        offset.set(0, 0, 0);
        offset.add(forward.mulScalar(move[2]));
        offset.add(right.mulScalar(move[0]));
        offset.add(up.mulScalar(move[1]));
        this._targetPose.move(offset);
        // Apply damping using Pose.lerp
        this._pose.lerp(this._pose, this._targetPose, damp(this.moveDamping, deltaTime), damp(this.rotateDamping, deltaTime), 1);
        // For roll, use target directly (no damping) for instant response
        // This prevents any delay or "bounce back" feeling
        this._pose.angles.z = this._targetPose.angles.z;
        // Update camera
        camera.position.copy(this._pose.position);
        camera.angles.copy(this._pose.angles);
        camera.distance = this._pose.distance;
        // Debug: Show roll angle in console title
        if (typeof document !== 'undefined' && Math.abs(camera.angles.z) > 0.1) {
            document.title = `Roll: ${camera.angles.z.toFixed(1)}°`;
        }
        else if (typeof document !== 'undefined') {
            document.title = 'SuperSplat Viewer';
        }
    }
    onExit(_camera) {
        // No cleanup needed
    }
    goto(pose) {
        this._targetPose.copy(pose);
        this._pose.copy(pose);
    }
}

const p = new Pose();
class OrbitController {
    controller;
    constructor() {
        this.controller = new OrbitController$1();
        this.controller.zoomRange = new Vec2(0.5, Infinity); // Minimum zoom distance to preserve pan functionality
        this.controller.pitchRange = new Vec2(-90, 90);
        this.controller.rotateDamping = 0.97;
        this.controller.moveDamping = 0.97;
        this.controller.zoomDamping = 0.97;
    }
    onEnter(camera) {
        p.position.copy(camera.position);
        p.angles.copy(camera.angles);
        p.distance = camera.distance;
        this.controller.attach(p, false);
    }
    update(deltaTime, inputFrame, camera) {
        const pose = this.controller.update(inputFrame, deltaTime);
        camera.position.copy(pose.position);
        camera.angles.copy(pose.angles);
        camera.distance = pose.distance;
    }
    onExit(_camera) {
    }
    goto(camera) {
        p.position.copy(camera.position);
        p.angles.copy(camera.angles);
        p.distance = camera.distance;
        this.controller.attach(p, true);
    }
}

const tmpCamera = new Camera();
const tmpv = new Vec3();
const createCamera = (position, target, fov) => {
    const result = new Camera();
    result.look(position, target);
    result.fov = fov;
    return result;
};
const createFrameCamera = (bbox, fov) => {
    const sceneSize = bbox.halfExtents.length();
    const distance = sceneSize / Math.sin(fov / 180 * Math.PI * 0.5);
    return createCamera(new Vec3(2, 1, 2).normalize().mulScalar(distance).add(bbox.center), bbox.center, fov);
};
class CameraManager {
    update;
    // holds the camera state
    camera = new Camera();
    // visual marker for picked point
    pickMarker = null;
    constructor(global, bbox) {
        const { events, settings, state, config, app } = global;
        // // Create a visual marker for picked points
        // const markerMaterial = new StandardMaterial();
        // markerMaterial.diffuse = new Color(1, 0, 0); // Red
        // markerMaterial.emissive = new Color(0.5, 0, 0); // Glowing red
        // markerMaterial.update();
        // this.pickMarker = new Entity('pickMarker');
        // this.pickMarker.addComponent('render', {
        //     type: 'sphere',
        //     material: markerMaterial
        // });
        // this.pickMarker.setLocalScale(0.3, 0.3, 0.3);
        // this.pickMarker.enabled = false;
        // app.root.addChild(this.pickMarker);
        const camera0 = settings.cameras[0].initial;
        const frameCamera = createFrameCamera(bbox, camera0.fov);
        const resetCamera = createCamera(new Vec3(camera0.position), new Vec3(camera0.target), camera0.fov);
        const getAnimTrack = (initial, isObjectExperience) => {
            const { animTracks } = settings;
            // extract the camera animation track from settings
            if (animTracks?.length > 0 && settings.startMode === 'animTrack') {
                // use the first animTrack
                return animTracks[0];
            }
            else if (isObjectExperience && !config.noautorotate) {
                // create basic rotation animation if no anim track is specified
                initial.calcFocusPoint(tmpv);
                return createRotateTrack(initial.position, tmpv, initial.fov);
            }
            return null;
        };
        // object experience starts outside the bounding box
        const isObjectExperience = !bbox.containsPoint(resetCamera.position);
        const animTrack = getAnimTrack(settings.hasStartPose ? resetCamera : frameCamera, isObjectExperience);
        const controllers = {
            orbit: new OrbitController(),
            fly: new FlyController(),
            anim: animTrack ? new AnimController(animTrack) : null
        };
        const getController = (cameraMode) => {
            return controllers[cameraMode];
        };
        // set the global animation flag
        state.hasAnimation = !!controllers.anim;
        state.animationDuration = controllers.anim ? controllers.anim.animState.cursor.duration : 0;
        // initialize camera mode and initial camera position
        state.cameraMode = state.hasAnimation ? 'anim' : 'orbit';
        this.camera.copy(resetCamera);
        const target = new Camera(this.camera); // the active controller updates this
        const from = new Camera(this.camera); // stores the previous camera state during transition
        let fromMode = 'orbit';
        // enter the initial controller
        getController(state.cameraMode).onEnter(this.camera);
        // transition time between cameras
        const transitionSpeed = 2.0;
        let transitionTimer = 1;
        // application update
        this.update = (deltaTime, frame) => {
            // use dt of 0 if animation is paused
            const dt = state.cameraMode === 'anim' && state.animationPaused ? 0 : deltaTime;
            // update transition timer
            transitionTimer = Math.min(1, transitionTimer + deltaTime * transitionSpeed);
            const controller = getController(state.cameraMode);
            controller.update(dt, frame, target);
            if (transitionTimer < 1) {
                // lerp away from previous camera during transition
                // Use smootherStep for ultra-smooth transitions
                this.camera.lerp(from, target, smootherStep(transitionTimer));
            }
            else {
                this.camera.copy(target);
            }
            // Auto-switch from orbit to fly when zoomed to minimum distance
            // This allows seamless transition when user wants to get closer
            // Check target.distance (updated by orbit controller) not this.camera.distance
            if (state.cameraMode === 'orbit' && transitionTimer >= 1) {
                const minZoomThreshold = 0.55; // Just above the minimum zoom range (0.5)
                // Switch to fly mode when at minimum zoom distance
                // This allows user to continue moving closer
                if (target.distance <= minZoomThreshold) {
                    console.log('Auto-switching to fly mode: target.distance =', target.distance);
                    state.cameraMode = 'fly';
                }
            }
            // update animation timeline
            if (state.cameraMode === 'anim') {
                state.animationTime = controllers.anim.animState.cursor.value;
            }
        };
        // handle input events
        events.on('inputEvent', (eventName, event) => {
            switch (eventName) {
                case 'frame':
                    state.cameraMode = 'orbit';
                    controllers.orbit.goto(frameCamera);
                    break;
                case 'reset':
                    state.cameraMode = 'orbit';
                    controllers.orbit.goto(resetCamera);
                    break;
                case 'playPause':
                    if (state.hasAnimation) {
                        if (state.cameraMode === 'anim') {
                            state.animationPaused = !state.animationPaused;
                        }
                        else {
                            state.cameraMode = 'anim';
                            state.animationPaused = false;
                        }
                    }
                    break;
                case 'cancel':
                case 'interrupt':
                    if (state.cameraMode === 'anim') {
                        state.cameraMode = fromMode;
                    }
                    break;
            }
        });
        // handle camera mode switching
        events.on('cameraMode:changed', (value, prev) => {
            // store previous camera mode and pose
            target.copy(this.camera);
            from.copy(this.camera);
            fromMode = prev;
            // exit the old controller
            const prevController = getController(prev);
            prevController.onExit(this.camera);
            // Adjust distance when switching from fly to orbit
            // Fly mode uses very small distance, but orbit needs a reasonable distance
            // to define the focus point. We keep the camera position unchanged and just
            // adjust the distance to set where the orbit focus point will be.
            if (prev === 'fly' && value === 'orbit') {
                // Use a distance that's above the minimum zoom range (0.5) to avoid
                // the orbit controller trying to adjust the camera position
                const minOrbitDistance = 3.0;
                if (this.camera.distance < minOrbitDistance) {
                    // Only adjust distance, camera position stays the same
                    // The focus point will be calculated as: position + direction * distance
                    this.camera.distance = minOrbitDistance;
                }
            }
            // enter new controller
            const newController = getController(value);
            newController.onEnter(this.camera);
            // reset camera transition timer
            transitionTimer = 0;
            // notify input controller about mode change
            events.fire('cameraModeChanged', value, prev);
        });
        // handle user scrubbing the animation timeline
        events.on('scrubAnim', (time) => {
            // switch to animation camera if we're not already there
            state.cameraMode = 'anim';
            // set time
            controllers.anim.animState.cursor.value = time;
        });
        // handle user picking in the scene
        events.on('pick', (position) => {
            // Show visual marker at picked position
            // if (this.pickMarker) {
            //     this.pickMarker.setPosition(position);
            //     this.pickMarker.enabled = true;
            //     // Hide marker after 3 seconds
            //     setTimeout(() => {
            //         if (this.pickMarker) {
            //             this.pickMarker.enabled = false;
            //         }
            //     }, 3000);
            // }
            // Switch to orbit mode on double-tap (only if not already in orbit mode)
            if (state.cameraMode !== 'orbit') {
                state.cameraMode = 'orbit';
            }
            // construct camera - look at the picked target from current position
            tmpCamera.copy(this.camera);
            // Calculate direction from camera to picked point
            const direction = tmpv.copy(position).sub(this.camera.position).normalize();
            // Calculate a good viewing distance (move much closer to target)
            const currentDistance = position.distance(this.camera.position);
            // Use a smaller multiplier (0.2) and lower minimum (1.0) to get closer
            const targetDistance = Math.max(1.0, currentDistance * 0.2);
            // Position camera at the target distance, looking at the picked point
            const newPosition = tmpv.copy(direction).mulScalar(-targetDistance).add(position);
            tmpCamera.position.copy(newPosition);
            // Make camera look at the picked point (this centers the target)
            // The look() method automatically sets the correct distance
            tmpCamera.look(newPosition, position);
            controllers.orbit.goto(tmpCamera);
            // Fly mode version (commented out for now, as requested)
            // if (currentMode === 'fly') {
            //     const targetPose = new Pose();
            //     targetPose.position.copy(tmpCamera.position);
            //     targetPose.angles.copy(tmpCamera.angles);
            //     targetPose.distance = tmpCamera.distance;
            //     controllers.fly.goto(targetPose);
            // }
        });
        events.on('annotation.activate', (annotation) => {
            // switch to orbit camera on pick (only if not already in orbit mode)
            if (state.cameraMode !== 'orbit') {
                state.cameraMode = 'orbit';
            }
            const { initial } = annotation.camera;
            // construct camera
            tmpCamera.fov = initial.fov;
            tmpCamera.look(new Vec3(initial.position), new Vec3(initial.target));
            controllers.orbit.goto(tmpCamera);
        });
    }
}

/**
 * Custom mobile input handler for fly camera with fixed joystick position
 * - Joystick fixed in bottom-right corner for movement
 * - Single finger anywhere else for look around
 * - Separated from orbit gestures
 */
class MobileFlyInput {
    // Joystick configuration
    joystickRadius = 96;
    joystickDeadZone = 8;
    joystickPosition = { x: 0, y: 0 }; // Will be set based on screen size
    // Touch tracking
    touches = new Map();
    joystickTouchId = null;
    lookTouchId = null;
    lookTouchStartTime = 0;
    totalTouchCount = 0;
    // Output values
    moveInput = new Vec2(0, 0);
    lookInput = new Vec2(0, 0);
    isJoystickActive = false;
    // Enable/disable flags
    joystickEnabled = false; // Joystick movement control
    lookEnabled = true; // Single finger look around (always enabled)
    // Canvas reference
    canvas;
    // Mouse support for PC debugging
    mouseDown = false;
    mouseId = -1;
    // Joystick DOM element for direct interaction
    joystickElement = null;
    constructor(canvas) {
        this.canvas = canvas;
        this.updateJoystickPosition();
        // Update joystick position on resize
        window.addEventListener('resize', () => this.updateJoystickPosition());
        // Touch event listeners on canvas
        canvas.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
        canvas.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
        canvas.addEventListener('touchend', (e) => this.onTouchEnd(e), { passive: false });
        canvas.addEventListener('touchcancel', (e) => this.onTouchEnd(e), { passive: false });
        // Mouse event listeners for PC debugging on canvas
        canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
        canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
        canvas.addEventListener('mouseup', (e) => this.onMouseUp(e));
        canvas.addEventListener('mouseleave', (e) => this.onMouseUp(e));
    }
    /**
     * Attach joystick DOM element for direct interaction
     * This is needed because the joystick HTML element is above the canvas
     */
    attachJoystickElement(element) {
        console.log('MobileFlyInput: Attaching joystick element', element);
        this.joystickElement = element;
        // Enable joystick when element is attached
        this.joystickEnabled = true;
        // Make sure element can receive pointer events
        element.style.touchAction = 'none';
        element.style.pointerEvents = 'auto';
        // Add event listeners to joystick element
        element.addEventListener('pointerdown', (e) => {
            console.log('MobileFlyInput: pointerdown', e);
            this.onJoystickPointerDown(e);
        });
        element.addEventListener('pointermove', (e) => {
            this.onJoystickPointerMove(e);
        });
        element.addEventListener('pointerup', (e) => {
            console.log('MobileFlyInput: pointerup', e);
            this.onJoystickPointerUp(e);
        });
        element.addEventListener('pointercancel', (e) => {
            this.onJoystickPointerUp(e);
        });
        element.addEventListener('pointerleave', (e) => {
            this.onJoystickPointerUp(e);
        });
        console.log('MobileFlyInput: Event listeners attached');
    }
    updateJoystickPosition() {
        const rect = this.canvas.getBoundingClientRect();
        // Position in bottom-left corner with safe margins
        const marginLeft = Math.max(24, 24); // Safe area inset
        const marginBottom = Math.max(80, 80); // Above controls
        this.joystickPosition.x = marginLeft + this.joystickRadius / 2;
        this.joystickPosition.y = rect.height - marginBottom - this.joystickRadius / 2;
    }
    isInJoystickArea(x, y) {
        const dx = x - this.joystickPosition.x;
        const dy = y - this.joystickPosition.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        return distance <= this.joystickRadius;
    }
    /**
     * Public method to check if a point is in the joystick area
     * Useful for filtering out double-tap events in the joystick region
     */
    isPointInJoystickArea(clientX, clientY) {
        const rect = this.canvas.getBoundingClientRect();
        const x = clientX - rect.left;
        const y = clientY - rect.top;
        return this.isInJoystickArea(x, y);
    }
    onTouchStart(event) {
        // Update total touch count
        this.totalTouchCount = event.touches.length;
        for (let i = 0; i < event.changedTouches.length; i++) {
            const touch = event.changedTouches[i];
            const rect = this.canvas.getBoundingClientRect();
            const x = touch.clientX - rect.left;
            const y = touch.clientY - rect.top;
            // Check if touch is in joystick area (only if joystick is enabled)
            if (this.joystickEnabled && this.joystickTouchId === null && this.isInJoystickArea(x, y)) {
                this.joystickTouchId = touch.identifier;
                this.isJoystickActive = true;
                this.touches.set(touch.identifier, {
                    startX: x,
                    startY: y,
                    currentX: x,
                    currentY: y,
                    startTime: Date.now()
                });
            }
            else if (this.lookEnabled && this.lookTouchId === null && this.totalTouchCount === 1) {
                // Only register look touch if this is a single finger touch
                // This prevents conflict with two-finger gestures
                this.lookTouchId = touch.identifier;
                this.lookTouchStartTime = Date.now();
                this.touches.set(touch.identifier, {
                    startX: x,
                    startY: y,
                    currentX: x,
                    currentY: y,
                    startTime: Date.now()
                });
            }
        }
        // If a second finger is added, clear the look touch to avoid conflicts
        if (this.totalTouchCount >= 2 && this.lookTouchId !== null) {
            this.lookTouchId = null;
            this.lookInput.set(0, 0);
        }
    }
    onTouchMove(event) {
        event.preventDefault();
        for (let i = 0; i < event.changedTouches.length; i++) {
            const touch = event.changedTouches[i];
            const touchData = this.touches.get(touch.identifier);
            if (touchData) {
                const rect = this.canvas.getBoundingClientRect();
                touchData.currentX = touch.clientX - rect.left;
                touchData.currentY = touch.clientY - rect.top;
            }
        }
        this.updateInputs();
    }
    onTouchEnd(event) {
        // Update total touch count
        this.totalTouchCount = event.touches.length;
        for (let i = 0; i < event.changedTouches.length; i++) {
            const touch = event.changedTouches[i];
            if (touch.identifier === this.joystickTouchId) {
                this.joystickTouchId = null;
                this.isJoystickActive = false;
                this.moveInput.set(0, 0);
            }
            if (touch.identifier === this.lookTouchId) {
                this.lookTouchId = null;
                this.lookInput.set(0, 0);
            }
            this.touches.delete(touch.identifier);
        }
    }
    updateInputs() {
        // Update joystick input (only if enabled)
        if (this.joystickEnabled && this.joystickTouchId !== null) {
            const touchData = this.touches.get(this.joystickTouchId);
            if (touchData) {
                // Calculate offset from joystick center (stored in startX/startY)
                const dx = touchData.currentX - touchData.startX;
                const dy = touchData.currentY - touchData.startY;
                const distance = Math.sqrt(dx * dx + dy * dy);
                console.log('Joystick input:', { dx, dy, distance, startX: touchData.startX, startY: touchData.startY, currentX: touchData.currentX, currentY: touchData.currentY });
                if (distance > this.joystickDeadZone) {
                    const maxDistance = this.joystickRadius / 2;
                    const normalizedDistance = Math.min(distance, maxDistance) / maxDistance;
                    const angle = Math.atan2(dy, dx);
                    this.moveInput.x = Math.cos(angle) * normalizedDistance;
                    this.moveInput.y = Math.sin(angle) * normalizedDistance;
                }
                else {
                    this.moveInput.set(0, 0);
                }
            }
        }
        // Update look input (delta-based)
        // Only process look input if enabled and there's a single touch (not two-finger gesture)
        if (this.lookEnabled && this.lookTouchId !== null && this.totalTouchCount <= 1) {
            const touchData = this.touches.get(this.lookTouchId);
            if (touchData) {
                // Ignore look input for the first 120ms to prevent interference with double-tap
                // This gives enough time for double-tap detection (max 400ms between taps)
                const touchDuration = Date.now() - this.lookTouchStartTime;
                if (touchDuration > 120) {
                    const dx = touchData.currentX - touchData.startX;
                    const dy = touchData.currentY - touchData.startY;
                    this.lookInput.x = dx;
                    this.lookInput.y = dy;
                    // Reset start position for continuous movement
                    touchData.startX = touchData.currentX;
                    touchData.startY = touchData.currentY;
                }
                else {
                    // During the delay period, keep look input at zero
                    this.lookInput.set(0, 0);
                }
            }
        }
        else if (this.totalTouchCount >= 2) {
            // Clear look input during two-finger gestures
            this.lookInput.set(0, 0);
        }
    }
    getJoystickVisualPosition() {
        if (!this.isJoystickActive) {
            return null;
        }
        const touchData = this.joystickTouchId !== null ? this.touches.get(this.joystickTouchId) : null;
        if (!touchData) {
            return null;
        }
        // Return position relative to joystick center (startX/startY)
        return {
            baseX: touchData.startX,
            baseY: touchData.startY,
            stickX: touchData.currentX - touchData.startX,
            stickY: touchData.currentY - touchData.startY
        };
    }
    // Joystick DOM element event handlers
    onJoystickPointerDown(event) {
        event.preventDefault();
        event.stopPropagation();
        const rect = this.canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        this.joystickTouchId = event.pointerId;
        this.isJoystickActive = true;
        this.touches.set(event.pointerId, {
            startX: this.joystickPosition.x,
            startY: this.joystickPosition.y,
            currentX: x,
            currentY: y,
            startTime: Date.now()
        });
        // Capture pointer to receive events even outside element
        if (this.joystickElement) {
            this.joystickElement.setPointerCapture(event.pointerId);
        }
    }
    onJoystickPointerMove(event) {
        if (event.pointerId === this.joystickTouchId) {
            event.preventDefault();
            event.stopPropagation();
            const rect = this.canvas.getBoundingClientRect();
            const touchData = this.touches.get(event.pointerId);
            if (touchData) {
                touchData.currentX = event.clientX - rect.left;
                touchData.currentY = event.clientY - rect.top;
                this.updateInputs();
            }
        }
    }
    onJoystickPointerUp(event) {
        if (event.pointerId === this.joystickTouchId) {
            event.preventDefault();
            event.stopPropagation();
            this.joystickTouchId = null;
            this.isJoystickActive = false;
            this.moveInput.set(0, 0);
            this.touches.delete(event.pointerId);
            // Release pointer capture
            if (this.joystickElement) {
                this.joystickElement.releasePointerCapture(event.pointerId);
            }
        }
    }
    // Mouse event handlers for PC debugging (fallback)
    onMouseDown(event) {
        const rect = this.canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        // Check if mouse is in joystick area
        if (this.isInJoystickArea(x, y)) {
            this.mouseDown = true;
            this.mouseId = -1; // Use -1 as mouse identifier
            this.joystickTouchId = this.mouseId;
            this.isJoystickActive = true;
            this.touches.set(this.mouseId, {
                startX: x,
                startY: y,
                currentX: x,
                currentY: y,
                startTime: Date.now()
            });
        }
    }
    onMouseMove(event) {
        if (this.mouseDown && this.mouseId === this.joystickTouchId) {
            const rect = this.canvas.getBoundingClientRect();
            const touchData = this.touches.get(this.mouseId);
            if (touchData) {
                touchData.currentX = event.clientX - rect.left;
                touchData.currentY = event.clientY - rect.top;
                this.updateInputs();
            }
        }
    }
    onMouseUp(_event) {
        if (this.mouseDown && this.mouseId === this.joystickTouchId) {
            this.mouseDown = false;
            this.joystickTouchId = null;
            this.isJoystickActive = false;
            this.moveInput.set(0, 0);
            this.touches.delete(this.mouseId);
        }
    }
    reset() {
        this.moveInput.set(0, 0);
        this.lookInput.set(0, 0);
        this.isJoystickActive = false;
        this.joystickTouchId = null;
        this.lookTouchId = null;
        this.touches.clear();
        this.mouseDown = false;
        this.totalTouchCount = 0;
    }
    setJoystickEnabled(enabled) {
        this.joystickEnabled = enabled;
        if (!enabled) {
            // Reset joystick input when disabled
            this.moveInput.set(0, 0);
            this.isJoystickActive = false;
            this.joystickTouchId = null;
        }
    }
    setLookEnabled(enabled) {
        this.lookEnabled = enabled;
        if (!enabled) {
            // Reset look input when disabled
            this.lookInput.set(0, 0);
            this.lookTouchId = null;
        }
    }
    isJoystickEnabled() {
        return this.joystickEnabled;
    }
    isLookEnabled() {
        return this.lookEnabled;
    }
}

const float32 = new Float32Array(1);
const uint8 = new Uint8Array(float32.buffer);
const two = new Vec4(2, 2, 2, 1);
const one = new Vec4(1, 1, 1, 0);
class Picker {
    app;
    camera;
    picker;
    constructor(app, camera) {
        this.app = app;
        this.camera = camera;
        this.picker = null;
    }
    async pick(x, y) {
        const { app, camera } = this;
        const { graphicsDevice } = app;
        const { canvas } = graphicsDevice;
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        y = graphicsDevice.isWebGL2 ? height - y - 1 : y;
        // construct picker on demand
        if (!this.picker) {
            this.picker = new Picker$1(app, width, height);
        }
        // render scene, read depth
        const { picker } = this;
        picker.resize(width, height);
        picker.prepare(camera.camera, app.scene, [app.scene.layers.getLayerByName('World')]);
        const pixels = await picker.renderTarget.colorBuffer.read(x, y, 1, 1, {
            renderTarget: picker.renderTarget
        });
        for (let i = 0; i < 4; ++i) {
            uint8[i] = pixels[i];
        }
        const depth = float32[0];
        // 255, 255, 255, 255 === NaN
        if (!isFinite(depth)) {
            return null;
        }
        // clip space
        const pos = new Vec4(x / width, y / height, depth, 1).mul(two).sub(one);
        if (!graphicsDevice.isWebGL2) {
            pos.y *= -1;
        }
        // homogeneous view space
        camera.camera.projectionMatrix.clone().invert().transformVec4(pos, pos);
        // perform perspective divide
        pos.mulScalar(1.0 / pos.w);
        // view to world space
        const pos3 = new Vec3(pos.x, pos.y, pos.z);
        camera.getWorldTransform().transformPoint(pos3, pos3);
        return pos3;
    }
}

const tmpV1 = new Vec3();
const tmpV2 = new Vec3();
/**
 * Converts screen space mouse deltas to world space pan vector.
 *
 * @param camera - The camera component.
 * @param dx - The mouse delta x value.
 * @param dy - The mouse delta y value.
 * @param dz - The world space zoom delta value.
 * @param out - The output vector to store the pan result.
 * @returns - The pan vector in world space.
 * @private
 */
const screenToWorld = (camera, dx, dy, dz, out = new Vec3()) => {
    const { system, fov, aspectRatio, horizontalFov, projection, orthoHeight } = camera;
    const { width, height } = system.app.graphicsDevice.clientRect;
    // normalize deltas to device coord space
    out.set(-(dx / width) * 2, (dy / height) * 2, 0);
    // calculate half size of the view frustum at the current distance
    const halfSize = tmpV2.set(0, 0, 0);
    if (projection === PROJECTION_PERSPECTIVE) {
        const halfSlice = dz * Math.tan(0.5 * fov * math.DEG_TO_RAD);
        // if (horizontalFov) {
        //     halfSize.set(
        //         halfSlice,
        //         halfSlice / aspectRatio,
        //         0
        //     );
        // } else {
        halfSize.set(halfSlice * aspectRatio, halfSlice, 0);
        // }
    }
    else {
        halfSize.set(orthoHeight * aspectRatio, orthoHeight, 0);
    }
    // scale by device coord space
    out.mul(halfSize);
    return out;
};
class InputController {
    _state = {
        axis: new Vec3(),
        mouse: [0, 0, 0],
        shift: 0,
        ctrl: 0,
        touches: 0,
        lastTouchCount: 0,
        twoFingerTapTimer: 0,
        currentTouchCount: 0,
        // Persistent key states for roll control
        keyQPressed: false,
        keyEPressed: false
    };
    _desktopInput = new KeyboardMouseSource();
    _orbitInput = new MultiTouchSource();
    _flyInput = new DualGestureSource();
    _mobileFlyInput = null;
    _gamepadInput = new GamepadSource();
    global;
    frame = new InputFrame({
        move: [0, 0, 0],
        rotate: [0, 0, 0]
    });
    joystick = { base: null, stick: null };
    // this gets overridden by the viewer based on scene size
    moveSpeed = 10;
    orbitSpeed = 18;
    pinchSpeed = 0.4;
    wheelSpeed = 0.06;
    // Minimum effective distance for pan calculations to prevent slow panning when zoomed in
    _minPanDistance = 1;
    /**
     * Set move speed based on scene size.
     * Larger scenes need faster movement speed for comfortable navigation.
     *
     * @param sceneSize - The size of the scene (typically bounding box diagonal length)
     */
    setMoveSpeedFromSceneSize(sceneSize) {
        // Scale move speed proportionally to scene size
        // Base speed of 10 for a scene size of ~10 units
        this.moveSpeed = Math.max(1, sceneSize * 0.5);
        // Set minimum pan distance to ensure smooth panning even when zoomed in
        // Use 10% of scene size as minimum, with a floor of 1
        this._minPanDistance = Math.max(1, sceneSize * 0.1);
    }
    constructor(global) {
        const { app, camera, events, state } = global;
        const canvas = app.graphicsDevice.canvas;
        this._desktopInput.attach(canvas);
        this._orbitInput.attach(canvas);
        this._flyInput.attach(canvas);
        // Initialize custom mobile fly input
        this._mobileFlyInput = new MobileFlyInput(canvas);
        // Try to find and attach joystick element immediately
        const joystickElement = document.getElementById('joystickBase');
        if (joystickElement) {
            if (joystickElement.classList.contains('hidden')) {
                // Joystick is hidden, disable joystick but keep look enabled
                console.log('InputController: Joystick is hidden, disabling joystick functionality');
                this._mobileFlyInput.setJoystickEnabled(false);
            }
            else {
                console.log('InputController: Found joystick element immediately', joystickElement);
                this._mobileFlyInput.attachJoystickElement(joystickElement);
            }
        }
        else {
            console.log('InputController: Joystick element not found, waiting for event');
        }
        // Also listen for the event in case it comes later
        events.on('joystickElementReady', (element) => {
            console.log('InputController: Received joystickElementReady event', element);
            if (this._mobileFlyInput) {
                this._mobileFlyInput.attachJoystickElement(element);
            }
            else {
                console.error('InputController: _mobileFlyInput is null!');
            }
        });
        // Listen for joystick disabled event
        events.on('joystickDisabled', () => {
            console.log('InputController: Joystick disabled');
            if (this._mobileFlyInput) {
                this._mobileFlyInput.setJoystickEnabled(false);
            }
        });
        // Reset mobile fly input when switching away from fly mode
        events.on('cameraModeChanged', (newMode, _prevMode) => {
            if (newMode !== 'fly' && this._mobileFlyInput) {
                this._mobileFlyInput.reset();
            }
        });
        // convert events to joystick state - always show in bottom left
        this._flyInput.on('joystick:position:left', ([bx, by, sx, sy]) => {
            if (bx < 0 || by < 0 || sx < 0 || sy < 0) {
                this.joystick.base = null;
                this.joystick.stick = null;
                return;
            }
            this.joystick.base = [bx, by];
            this.joystick.stick = [sx - bx, sy - by];
        });
        // Track touch count changes for two-finger detection
        let lastTouchCount = 0;
        let twoFingerStartTime = 0;
        canvas.addEventListener('touchstart', (event) => {
            const currentTouchCount = event.touches.length;
            // Detect two-finger tap
            if (currentTouchCount === 2 && lastTouchCount < 2) {
                twoFingerStartTime = Date.now();
            }
            lastTouchCount = currentTouchCount;
        });
        canvas.addEventListener('touchend', (event) => {
            const currentTouchCount = event.touches.length;
            // Two-finger tap completed (quick tap < 200ms)
            if (lastTouchCount === 2 && currentTouchCount < 2) {
                const tapDuration = Date.now() - twoFingerStartTime;
                if (tapDuration < 200) {
                    events.fire('twoFingerTap');
                }
            }
            lastTouchCount = currentTouchCount;
        });
        this.global = global;
        // Generate input events
        ['wheel', 'pointerdown', 'contextmenu', 'keydown'].forEach((eventName) => {
            canvas.addEventListener(eventName, (event) => {
                events.fire('inputEvent', 'interrupt', event);
            });
        });
        canvas.addEventListener('pointermove', (event) => {
            events.fire('inputEvent', 'interact', event);
        });
        // Detect double taps manually because iOS doesn't send dblclick events
        // Single finger double tap will switch to orbit mode and pick target
        const lastTap = { time: 0, x: 0, y: 0, pointerType: '' };
        canvas.addEventListener('pointerdown', (event) => {
            // Only process single touch/mouse events for double tap
            if (event.isPrimary) {
                const now = Date.now();
                const delay = Math.max(0, now - lastTap.time);
                // More lenient timing and position for mobile
                const isMobile = event.pointerType === 'touch';
                const maxDelay = isMobile ? 400 : 300; // Longer window for touch
                const maxDistance = isMobile ? 20 : 8; // Larger tolerance for touch
                if (delay < maxDelay &&
                    delay > 50 && // Minimum delay to avoid accidental triggers
                    Math.abs(event.clientX - lastTap.x) < maxDistance &&
                    Math.abs(event.clientY - lastTap.y) < maxDistance &&
                    event.pointerType === lastTap.pointerType) {
                    // Check if tap is not in joystick area (for mobile)
                    let isInJoystickArea = false;
                    if (this._mobileFlyInput && state.inputMode === 'touch') {
                        isInJoystickArea = this._mobileFlyInput.isPointInJoystickArea(event.clientX, event.clientY);
                    }
                    // Only fire dblclick if not in joystick area
                    // This will trigger pick event and switch to orbit mode
                    if (!isInJoystickArea) {
                        console.log('Double tap detected:', { delay, distance: Math.abs(event.clientX - lastTap.x) });
                        events.fire('inputEvent', 'dblclick', event);
                    }
                    lastTap.time = 0;
                }
                else {
                    lastTap.time = now;
                    lastTap.x = event.clientX;
                    lastTap.y = event.clientY;
                    lastTap.pointerType = event.pointerType;
                }
            }
        });
        // Calculate pick location on double click
        let picker = null;
        events.on('inputEvent', async (eventName, event) => {
            switch (eventName) {
                case 'dblclick': {
                    if (!picker) {
                        picker = new Picker(app, camera);
                    }
                    const result = await picker.pick(event.offsetX, event.offsetY);
                    if (result) {
                        events.fire('pick', result);
                    }
                    break;
                }
            }
        });
        // update input mode based on pointer event
        ['pointerdown', 'pointermove'].forEach((eventName) => {
            window.addEventListener(eventName, (event) => {
                state.inputMode = event.pointerType === 'touch' ? 'touch' : 'desktop';
            });
        });
        // handle keyboard events
        window.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                events.fire('inputEvent', 'cancel', event);
            }
            else if (!event.ctrlKey && !event.altKey && !event.metaKey) {
                switch (event.key) {
                    case 'f':
                        events.fire('inputEvent', 'frame', event);
                        break;
                    case 'r':
                        events.fire('inputEvent', 'reset', event);
                        break;
                    case ' ':
                        events.fire('inputEvent', 'playPause', event);
                        break;
                }
            }
        });
    }
    /**
     * @param dt - delta time in seconds
     * @param state - the current state of the app
     * @param state.cameraMode - the current camera mode
     * @param distance - the distance to the camera target
     */
    update(dt, distance) {
        const { keyCode } = KeyboardMouseSource;
        const { key, button, mouse, wheel } = this._desktopInput.read();
        const { events, state } = this.global;
        const { camera } = this.global.camera;
        const { touch, pinch, count } = this._orbitInput.read();
        const { leftInput, rightInput } = this._flyInput.read();
        const { leftStick, rightStick } = this._gamepadInput.read();
        // update state
        this._state.axis.add(tmpV1.set((key[keyCode.D] - key[keyCode.A]) + (key[keyCode.RIGHT] - key[keyCode.LEFT]), 0, // Y axis movement removed (was Q/E keys)
        (key[keyCode.W] - key[keyCode.S]) + (key[keyCode.UP] - key[keyCode.DOWN])));
        const currentTouchCount = count[0];
        this._state.touches += currentTouchCount;
        this._state.currentTouchCount = currentTouchCount;
        // No longer auto-switch to orbit on two-finger gesture
        // Two-finger gestures now work in both orbit and fly modes
        this._state.lastTouchCount = currentTouchCount;
        for (let i = 0; i < button.length; i++) {
            this._state.mouse[i] += button[i];
        }
        this._state.shift += key[keyCode.SHIFT];
        this._state.ctrl += key[keyCode.CTRL];
        // Switch to fly mode when using WASD or Q/E keys
        const hasMovementInput = this._state.axis.length() > 0;
        const hasRollInput = key[keyCode.Q] !== 0 || key[keyCode.E] !== 0;
        if (state.cameraMode !== 'fly' && (hasMovementInput || hasRollInput)) {
            state.cameraMode = 'fly';
        }
        const orbit = +(state.cameraMode === 'orbit');
        const fly = +(state.cameraMode === 'fly');
        const double = +(this._state.touches > 1);
        const pan = this._state.mouse[2] || +(button[2] === -1) || double;
        const orbitFactor = fly ? camera.fov / 120 : 1;
        const { deltas } = this.frame;
        // Use max of actual distance and minimum pan distance to prevent slow panning when zoomed in
        const effectivePanDistance = Math.max(distance, this._minPanDistance);
        // desktop move
        const v = tmpV1.set(0, 0, 0);
        const keyMove = this._state.axis.clone().normalize();
        v.add(keyMove.mulScalar(fly * this.moveSpeed * (this._state.shift ? 4 : this._state.ctrl ? 0.25 : 1) * dt));
        const panMove = screenToWorld(camera, mouse[0], mouse[1], effectivePanDistance);
        v.add(panMove.mulScalar(pan));
        const wheelMove = new Vec3(0, 0, -wheel[0]);
        v.add(wheelMove.mulScalar(this.wheelSpeed * dt));
        // FIXME: need to flip z axis for orbit camera
        deltas.move.append([v.x, v.y, orbit ? -v.z : v.z]);
        // desktop rotate
        v.set(0, 0, 0);
        const mouseRotate = new Vec3(mouse[0], mouse[1], 0);
        v.add(mouseRotate.mulScalar((1 - pan) * this.orbitSpeed * orbitFactor * dt));
        // Update persistent key states for Q/E
        // key[] contains deltas: 1 = pressed this frame, -1 = released this frame, 0 = no change
        if (key[keyCode.Q] === 1)
            this._state.keyQPressed = true;
        if (key[keyCode.Q] === -1)
            this._state.keyQPressed = false;
        if (key[keyCode.E] === 1)
            this._state.keyEPressed = true;
        if (key[keyCode.E] === -1)
            this._state.keyEPressed = false;
        // Add roll control with Q/E keys (only in fly mode)
        // Use persistent state, not deltas
        const keyQState = this._state.keyQPressed ? 1 : 0;
        const keyEState = this._state.keyEPressed ? 1 : 0;
        const keyDiff = keyEState - keyQState;
        const rollSpeedMultiplier = 3.0; // Increase roll speed (adjust as needed)
        const rollInput = keyDiff * fly * this.orbitSpeed * orbitFactor * dt * rollSpeedMultiplier;
        v.z += rollInput;
        deltas.rotate.append([v.x, v.y, v.z]);
        // mobile move
        v.set(0, 0, 0);
        // Two-finger pan: works in both orbit and fly modes
        const twoFingerPanMove = screenToWorld(camera, touch[0], touch[1], effectivePanDistance);
        v.add(twoFingerPanMove.mulScalar(pan));
        // Fly mode: use custom mobile fly input for separated joystick and look
        // Also works on desktop for debugging
        if (this._mobileFlyInput) {
            const { moveInput } = this._mobileFlyInput;
            const flyMove = new Vec3(moveInput.x, 0, -moveInput.y);
            v.add(flyMove.mulScalar(fly * this.moveSpeed * dt));
        }
        else {
            // Fallback to DualGestureSource only if MobileFlyInput is not available
            const flyMove = new Vec3(leftInput[0], 0, -leftInput[1]);
            v.add(flyMove.mulScalar(fly * this.moveSpeed * dt));
        }
        // Two-finger pinch zoom: works in both orbit and fly modes
        // In orbit mode: zoom in/out around target
        // In fly mode: move forward/backward
        const pinchMove = new Vec3(0, 0, pinch[0]);
        v.add(pinchMove.mulScalar(double * this.pinchSpeed * dt));
        // Need to flip z axis for orbit camera (same as desktop move)
        deltas.move.append([v.x, v.y, orbit ? v.z : -v.z]);
        // mobile rotate
        v.set(0, 0, 0);
        const orbitRotate = new Vec3(touch[0], touch[1], 0);
        v.add(orbitRotate.mulScalar(orbit * (1 - pan) * this.orbitSpeed * dt));
        // Fly mode: use custom mobile fly input for look around
        // Also works on desktop for debugging
        if (this._mobileFlyInput) {
            const { lookInput } = this._mobileFlyInput;
            const flyRotate = new Vec3(lookInput.x, lookInput.y, 0);
            v.add(flyRotate.mulScalar(fly * this.orbitSpeed * orbitFactor * dt * 0.8)); // Increased for more responsive control
        }
        else {
            // Fallback to DualGestureSource only if MobileFlyInput is not available
            const flyRotate = new Vec3(rightInput[0], rightInput[1], 0);
            v.add(flyRotate.mulScalar(fly * this.orbitSpeed * orbitFactor * dt));
        }
        // Only append if there's actual mobile input (don't override desktop roll with 0)
        if (v.x !== 0 || v.y !== 0) {
            deltas.rotate.append([v.x, v.y, 0]); // Mobile doesn't have roll control
        }
        // gamepad move
        v.set(0, 0, 0);
        const stickMove = new Vec3(leftStick[0], 0, -leftStick[1]);
        v.add(stickMove.mulScalar(this.moveSpeed * dt));
        deltas.move.append([v.x, v.y, v.z]);
        // gamepad rotate
        v.set(0, 0, 0);
        const stickRotate = new Vec3(rightStick[0], rightStick[1], 0);
        v.add(stickRotate.mulScalar(this.orbitSpeed * orbitFactor * dt));
        // Only append if there's actual gamepad input (don't override desktop roll with 0)
        if (v.x !== 0 || v.y !== 0) {
            deltas.rotate.append([v.x, v.y, 0]); // Gamepad doesn't have roll control
        }
        // update touch joystick UI - always show when using joystick
        // Auto-switch to fly mode when joystick is used
        // Works on both touch and desktop (for debugging)
        if (this._mobileFlyInput) {
            const { moveInput } = this._mobileFlyInput;
            const isUsingJoystick = moveInput.x !== 0 || moveInput.y !== 0;
            if (isUsingJoystick && state.cameraMode !== 'fly') {
                state.cameraMode = 'fly';
            }
            // Update joystick visual position
            const joystickPos = this._mobileFlyInput.getJoystickVisualPosition();
            if (joystickPos) {
                events.fire('touchJoystickUpdate', [joystickPos.baseX, joystickPos.baseY], [joystickPos.stickX, joystickPos.stickY]);
            }
            else {
                events.fire('touchJoystickUpdate', null, null);
            }
        }
    }
}

/**
 * Base class for gsplat shader effects.
 * Handles common functionality like material management, shader application,
 * time tracking, and uniform updates.
 *
 * **Usage:**
 * Attach this script to an entity with a gsplat component. The script automatically detects
 * whether the gsplat is in unified or non-unified mode and handles material access accordingly.
 *
 * **Non-Unified Mode (`unified=false`):**
 * Each gsplat component has its own material. The script accesses the material directly via
 * `entity.gsplat.material` and applies shader customizations immediately or when the asset loads.
 *
 * **Unified Mode (`unified=true`):**
 * Multiple gsplat components share materials per camera/layer combination. Materials are created
 * during the first frame render. The script listens to the 'material:created' event for immediate
 * notification and retries each frame as fallback to ensure materials are applied.
 *
 * **Enable/Disable:**
 * When enabled, the shader effect is applied and effectTime starts tracking from 0.
 * When disabled, the custom shader is removed and materials revert to default rendering.
 *
 * Subclasses must implement:
 * - getShaderGLSL(): Return GLSL shader string
 * - getShaderWGSL(): Return WGSL shader string
 * - updateEffect(effectTime, dt): Update effect each frame
 *
 * @abstract
 */
class GsplatShaderEffect extends Script {
    static scriptName = 'gsplatShaderEffect';
    initialized = false;
    shadersNeedApplication = false;
    needsRetry = false;
    /**
     * Center of the gsplat shader effect
     * @type {Vec3}
     */
    center = null;
    /**
     * Radius of the gsplat shader effect
     * @type {number}
     */
    radius = 0;
    /**
     * Optional camera entity to target in unified mode. If not set, applies to all cameras.
     *
     * @attribute
     * @type {import('playcanvas').Entity | null}
     */
    camera = null;
    /**
     * Time since effect was enabled
     * @type {number}
     */
    effectTime = 0;
    /**
     * Set of materials with applied shader
     * @type {Set<import('playcanvas').Material>}
     */
    materialsApplied = new Set();
    /**
     * Material created handler
     * @type {any}
     * @private
     */
    _materialCreatedHandler;
    /**
     * Material layer map
     * @type {Map<Material, number>}
     * @private
     */
    _materialLayers;
    initialize() {
        console.log('GsplatShaderEffect initialize() called for entity:', this.entity.name);
        // this.initialized = false;
        this.effectTime = 0;
        this.materialsApplied.clear();
        // this.shadersNeedApplication = false;
        // Listen to enable/disable events
        this.on('enable', () => {
            console.log('GsplatShaderEffect enabled for entity:', this.entity.name);
            // Reset effect time when enabling
            this.effectTime = 0;
            // Ensure we're initialized
            if (!this.initialized && this.entity.gsplat) {
                this.initialized = true;
                console.log('GsplatShaderEffect initialized');
            }
            // Apply shaders if initialized, otherwise flag for application
            if (this.initialized) {
                console.log('Applying shaders immediately');
                this.applyShaders();
            }
            else {
                console.log('Flagging shaders for later application');
                this.shadersNeedApplication = true;
            }
        });
        this.on('disable', () => {
            // Remove shaders when disabling
            this.removeShaders();
        });
        // Register event listener immediately for unified mode to catch materials created on first frame
        // This is safe to call even if the gsplat component doesn't exist yet
        this.setupUnifiedEventListener();
        if (!this.entity.gsplat) {
            // gsplat component not yet available, will retry each frame
            return;
        }
        this.initialized = true;
        // Apply shaders immediately since we're enabled by default
        if (this.enabled) {
            this.applyShaders();
        }
    }
    applyShaders() {
        console.log('GsplatShaderEffect applyShaders() called. GSplat unified:', this.entity.gsplat?.unified);
        if (this.entity.gsplat?.unified) {
            // Unified mode: Apply to specified camera (or all cameras if not specified)
            console.log('Applying to unified materials');
            this.applyToUnifiedMaterials();
        }
        else {
            // Non-unified mode: Apply to component's material
            console.log('Applying to component material');
            this.applyToComponentMaterial();
        }
        console.log('Materials applied count:', this.materialsApplied.size);
    }
    removeShaders() {
        if (this.materialsApplied.size === 0)
            return;
        const device = this.app.graphicsDevice;
        const shaderLanguage = device?.isWebGPU ? 'wgsl' : 'glsl';
        // Remove custom shader chunk from all materials
        this.materialsApplied.forEach((material) => {
            material.getShaderChunks(shaderLanguage).delete('gsplatCustomizeVS');
            material.update();
        });
        // Clear the set and stop tracking
        this.materialsApplied.clear();
    }
    setupUnifiedEventListener() {
        // Only set up once
        if (this._materialCreatedHandler)
            return;
        // @ts-ignore - gsplat system exists at runtime
        const gsplatSystem = this.app.systems.gsplat;
        // Set up event listener
        this._materialCreatedHandler = (material, camera, layer) => {
            // Only apply if enabled
            if (!this.enabled)
                return;
            // Apply shader immediately when material is created
            // The gsplat component may not be fully initialized yet, so we can't check it here
            if (!this.materialsApplied.has(material)) {
                // Check camera filter if specified
                if (this.camera && this.camera.camera && this.camera.camera.camera !== camera) {
                    return;
                }
                this.applyShaderToMaterial(material);
                this.materialsApplied.add(material);
                // Store layer info for potential validation later
                if (!this._materialLayers) {
                    this._materialLayers = new Map();
                }
                this._materialLayers.set(material, layer.id);
            }
        };
        gsplatSystem.on('material:created', this._materialCreatedHandler);
    }
    applyToComponentMaterial() {
        console.log('applyToComponentMaterial called');
        const applyShader = () => {
            const material = this.entity.gsplat?.material;
            console.log('Attempting to apply shader to material:', material);
            if (!material) {
                console.error(`${this.constructor.name}: gsplat material not available.`);
                return;
            }
            this.applyShaderToMaterial(material);
            this.materialsApplied.add(material);
            console.log('Material added to applied set. Total materials:', this.materialsApplied.size);
        };
        if (this.entity.gsplat?.material) {
            console.log('GSplat material available immediately');
            applyShader();
        }
        else {
            console.log('GSplat material not available, waiting for load event');
            // Listen for when the gsplat component is ready
            this.entity.gsplat?.once('load', applyShader);
        }
    }
    applyToUnifiedMaterials() {
        // Try to apply immediately to any existing materials
        this.updateUnifiedMaterials();
        // If no materials yet, set retry flag (event listener is already set up)
        if (this.materialsApplied.size === 0) {
            this.needsRetry = true;
        }
    }
    updateUnifiedMaterials() {
        // @ts-ignore - gsplat system exists at runtime
        const gsplatSystem = this.app.systems.gsplat;
        const scene = this.app.scene;
        const composition = scene.layers;
        // Get all layers this component is on
        const componentLayers = this.entity.gsplat?.layers;
        if (!componentLayers)
            return;
        // Determine which cameras to target
        let targetCameras;
        if (this.camera && this.camera.camera) {
            // Specific camera specified via attribute
            targetCameras = [this.camera.camera];
        }
        else {
            // All cameras in the composition
            targetCameras = composition.cameras.map(cameraComponent => cameraComponent.camera);
        }
        // Iterate through target cameras (already Camera objects, not CameraComponents)
        targetCameras.forEach((camera) => {
            // For each layer this component is on
            componentLayers.forEach((layerId) => {
                // Check if this camera renders this layer
                if (camera.layers.indexOf(layerId) >= 0) {
                    const layer = composition.getLayerById(layerId);
                    if (layer) {
                        const material = gsplatSystem.getGSplatMaterial(camera, layer);
                        if (material && !this.materialsApplied.has(material)) {
                            this.applyShaderToMaterial(material);
                            this.materialsApplied.add(material);
                        }
                    }
                }
            });
        });
        if (this.materialsApplied.size > 0) {
            this.needsRetry = false;
            // Keep event listener active to catch any new materials created later
        }
    }
    applyShaderToMaterial(material) {
        const device = this.app.graphicsDevice;
        const shaderLanguage = device?.isWebGPU ? 'wgsl' : 'glsl';
        const customShader = shaderLanguage === 'wgsl' ? this.getShaderWGSL() : this.getShaderGLSL();
        console.log('Applying shader to material:', material.name, 'Language:', shaderLanguage);
        console.log('Custom shader length:', customShader.length);
        material.getShaderChunks(shaderLanguage).set('gsplatCustomizeVS', customShader);
        material.update();
        console.log('Shader applied and material updated');
    }
    update(dt) {
        // If not initialized, try to complete initialization
        if (!this.initialized) {
            if (this.entity.gsplat) {
                this.initialized = true;
                // Apply shaders now if we're enabled and they're needed
                if (this.enabled && this.shadersNeedApplication) {
                    this.applyShaders();
                    this.shadersNeedApplication = false;
                }
            }
            return; // Don't proceed with updates until initialized
        }
        // Apply shaders if they're needed (can happen if enabled after initialization)
        if (this.shadersNeedApplication) {
            this.applyShaders();
            this.shadersNeedApplication = false;
        }
        // Retry applying to unified materials if needed
        if (this.entity.gsplat?.unified && this.needsRetry) {
            this.updateUnifiedMaterials();
        }
        if (this.materialsApplied.size === 0)
            return;
        // Update time
        this.effectTime += dt;
        // Let subclass update the effect
        this.updateEffect(this.effectTime, dt);
        // Request render on next frame when effect is active
        // This ensures the reveal effect updates even when camera is not moving
        if (this.enabled && this.materialsApplied.size > 0) {
            this.app.renderNextFrame = true;
        }
    }
    destroy() {
        // Remove shaders if they're still applied
        this.removeShaders();
        // Clean up event listener
        if (this._materialCreatedHandler) {
            // @ts-ignore - gsplat system exists at runtime
            this.app.systems.gsplat.off('material:created', this._materialCreatedHandler);
            this._materialCreatedHandler = null;
        }
    }
    /**
     * Get the GLSL shader string.
     * Must be implemented by subclasses.
     * @returns {string} GLSL shader code
     * @abstract
     */
    getShaderGLSL() {
        throw new Error(`${this.constructor.name} must implement getShaderGLSL()`);
    }
    /**
     * Get the WGSL shader string.
     * Must be implemented by subclasses.
     * @returns {string} WGSL shader code
     * @abstract
     */
    getShaderWGSL() {
        throw new Error(`${this.constructor.name} must implement getShaderWGSL()`);
    }
    /**
     * Set a uniform value on all applied materials.
     * @param {string} name - The uniform name
     * @param {*} value - The uniform value
     */
    setUniform(name, value) {
        this.materialsApplied.forEach((material) => {
            material.setParameter(name, value);
        });
        // Request render on next frame when uniforms change
        this.app.renderNextFrame = true;
    }
    /**
     * Set the center point for the effect.
     * This is a convenience method that subclasses can override for custom behavior.
     * @param {import('playcanvas').Vec3} center - The new center position
     */
    setCenter(center) {
        // Default implementation: update center attribute if it exists
        if (this.center) {
            this.center.copy(center);
        }
        // Update uniform if materials are applied
        if (this.materialsApplied.size > 0) {
            const centerArray = [center.x, center.y, center.z];
            this.setUniform('uCenter', centerArray);
        }
    }
    /**
     * Set the radius for the effect.
     * This is a convenience method that subclasses can override for custom behavior.
     * @param {number} radius - The new radius value
     */
    setRadius(radius) {
        // Default implementation: update radius attribute if it exists
        if (this.hasOwnProperty('radius')) {
            this.radius = radius;
        }
        // Update uniform if materials are applied
        if (this.materialsApplied.size > 0) {
            this.setUniform('uRadius', radius);
            // Also update endRadius if it exists
            if (this.hasOwnProperty('endRadius')) {
                this.setUniform('uEndRadius', radius);
            }
        }
    }
    /**
     * Update effect each frame.
     * Must be implemented by subclasses if they need to update uniforms or check completion.
     * @param {number} effectTime - Time since effect was enabled in seconds
     * @param {number} dt - Delta time in seconds
     * @abstract
     */
    updateEffect(effectTime, dt) {
        // Optional to override
    }
}

const shaderGLSL$2 = /* glsl */ `
uniform float uTime;
uniform vec3 uCenter;
uniform float uSpeed;
uniform float uAcceleration;
uniform float uDelay;
uniform vec3 uDotTint;
uniform vec3 uWaveTint;
uniform float uOscillationIntensity;
uniform float uEndRadius;

// Shared globals (initialized once per vertex)
float g_dist;
float g_dotWavePos;
float g_liftTime;
float g_liftWavePos;

void initShared(vec3 center) {
    g_dist = length(center - uCenter);
    g_dotWavePos = uSpeed * uTime + 0.5 * uAcceleration * uTime * uTime;
    g_liftTime = max(0.0, uTime - uDelay);
    g_liftWavePos = uSpeed * g_liftTime + 0.5 * uAcceleration * g_liftTime * g_liftTime;
}

// Hash function for per-splat randomization
float hash(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

void modifyCenter(inout vec3 center) {
    initShared(center);
    
    // Early exit optimization
    if (g_dist > uEndRadius) return;
    
    // Only apply oscillation if lift wave hasn't fully passed
    bool wavesActive = g_liftTime <= 0.0 || g_dist > g_liftWavePos - 1.5;
    if (wavesActive) {
        // Apply oscillation with per-splat phase offset
        float phase = hash(center) * 6.28318;
        center.y += sin(uTime * 3.0 + phase) * uOscillationIntensity * 0.25;
    }
    
    // Apply lift effect near the wave edge
    float distToLiftWave = abs(g_dist - g_liftWavePos);
    if (distToLiftWave < 1.0 && g_liftTime > 0.0) {
        // Create a smooth lift curve (peaks at wave edge)
        // Lift is 0.9x the oscillation intensity (30% of original 3x)
        float liftAmount = (1.0 - distToLiftWave) * sin(distToLiftWave * 3.14159);
        center.y += liftAmount * uOscillationIntensity * 0.9;
    }
}

void modifyCovariance(vec3 originalCenter, vec3 modifiedCenter, inout vec3 covA, inout vec3 covB) {
    // Early exit for distant splats - hide them
    if (g_dist > uEndRadius) {
        gsplatMakeRound(covA, covB, 0.0);
        return;
    }
    
    // Determine scale and phase
    float scale;
    bool isLiftWave = g_liftTime > 0.0 && g_liftWavePos > g_dist;
    
    if (isLiftWave) {
        // Lift wave: transition from dots to full size
        scale = (g_liftWavePos >= g_dist + 2.0) ? 1.0 : mix(0.1, 1.0, (g_liftWavePos - g_dist) * 0.5);
    } else if (g_dist > g_dotWavePos + 1.0) {
        // Before dot wave: invisible
        gsplatMakeRound(covA, covB, 0.0);
        return;
    } else if (g_dist > g_dotWavePos - 1.0) {
        // Dot wave front: scale from 0 to 0.1 with 2x peak at center
        float distToWave = abs(g_dist - g_dotWavePos);
        scale = (distToWave < 0.5) 
            ? mix(0.1, 0.2, 1.0 - distToWave * 2.0)
            : mix(0.0, 0.1, smoothstep(g_dotWavePos + 1.0, g_dotWavePos - 1.0, g_dist));
    } else {
        // After dot wave, before lift: small dots
        scale = 0.1;
    }
    
    // Apply scale to covariance
    if (scale >= 1.0) {
        // Fully revealed: original shape and size (no-op)
        return;
    } else if (isLiftWave) {
        // Lift wave: lerp from round dots to original shape
        float t = (scale - 0.1) * 1.111111; // normalize [0.1, 1.0] to [0, 1]
        float dotSize = scale * 0.05;
        float originalSize = gsplatExtractSize(covA, covB);
        float finalSize = mix(dotSize, originalSize, t);
        
        // Lerp between round and scaled original
        vec3 origCovA = covA * (scale * scale);
        vec3 origCovB = covB * (scale * scale);
        gsplatMakeRound(covA, covB, finalSize);
        covA = mix(covA, origCovA, t);
        covB = mix(covB, origCovB, t);
    } else {
        // Dot phase: round with absolute size, but don't make small splats larger
        float originalSize = gsplatExtractSize(covA, covB);
        gsplatMakeRound(covA, covB, min(scale * 0.05, originalSize));
    }
}

void modifyColor(vec3 center, inout vec4 color) {
    // Use shared globals
    if (g_dist > uEndRadius) return;
    
    // Lift wave tint takes priority (active during lift)
    if (g_liftTime > 0.0 && g_dist >= g_liftWavePos - 1.5 && g_dist <= g_liftWavePos + 0.5) {
        float distToLift = abs(g_dist - g_liftWavePos);
        float liftIntensity = smoothstep(1.5, 0.0, distToLift);
        color.rgb += uWaveTint * liftIntensity;
    }
    // Dot wave tint (active in dot phase, but not where lift wave is active)
    else if (g_dist <= g_dotWavePos && (g_liftTime <= 0.0 || g_dist > g_liftWavePos + 0.5)) {
        float distToDot = abs(g_dist - g_dotWavePos);
        float dotIntensity = smoothstep(1.0, 0.0, distToDot);
        color.rgb += uDotTint * dotIntensity;
    }
}
`;
const shaderWGSL$2 = /* wgsl */ `
uniform uTime: f32;
uniform uCenter: vec3f;
uniform uSpeed: f32;
uniform uAcceleration: f32;
uniform uDelay: f32;
uniform uDotTint: vec3f;
uniform uWaveTint: vec3f;
uniform uOscillationIntensity: f32;
uniform uEndRadius: f32;

// Shared globals (initialized once per vertex)
var<private> g_dist: f32;
var<private> g_dotWavePos: f32;
var<private> g_liftTime: f32;
var<private> g_liftWavePos: f32;

fn initShared(center: vec3f) {
    g_dist = length(center - uniform.uCenter);
    g_dotWavePos = uniform.uSpeed * uniform.uTime + 0.5 * uniform.uAcceleration * uniform.uTime * uniform.uTime;
    g_liftTime = max(0.0, uniform.uTime - uniform.uDelay);
    g_liftWavePos = uniform.uSpeed * g_liftTime + 0.5 * uniform.uAcceleration * g_liftTime * g_liftTime;
}

// Hash function for per-splat randomization
fn hash(p: vec3f) -> f32 {
    return fract(sin(dot(p, vec3f(127.1, 311.7, 74.7))) * 43758.5453);
}

fn modifyCenter(center: ptr<function, vec3f>) {
    initShared(*center);
    
    // Early exit optimization
    if (g_dist > uniform.uEndRadius) {
        return;
    }
    
    // Only apply oscillation if lift wave hasn't fully passed
    let wavesActive = g_liftTime <= 0.0 || g_dist > g_liftWavePos - 1.5;
    if (wavesActive) {
        // Apply oscillation with per-splat phase offset
        let phase = hash(*center) * 6.28318;
        (*center).y += sin(uniform.uTime * 3.0 + phase) * uniform.uOscillationIntensity * 0.25;
    }
    
    // Apply lift effect near the wave edge
    let distToLiftWave = abs(g_dist - g_liftWavePos);
    if (distToLiftWave < 1.0 && g_liftTime > 0.0) {
        // Create a smooth lift curve (peaks at wave edge)
        // Lift is 0.9x the oscillation intensity (30% of original 3x)
        let liftAmount = (1.0 - distToLiftWave) * sin(distToLiftWave * 3.14159);
        (*center).y += liftAmount * uniform.uOscillationIntensity * 0.9;
    }
}

fn modifyCovariance(originalCenter: vec3f, modifiedCenter: vec3f, covA: ptr<function, vec3f>, covB: ptr<function, vec3f>) {
    // Early exit for distant splats - hide them
    if (g_dist > uniform.uEndRadius) {
        gsplatMakeRound(covA, covB, 0.0);
        return;
    }
    
    // Determine scale and phase
    var scale: f32;
    let isLiftWave = g_liftTime > 0.0 && g_liftWavePos > g_dist;
    
    if (isLiftWave) {
        // Lift wave: transition from dots to full size
        scale = select(mix(0.1, 1.0, (g_liftWavePos - g_dist) * 0.5), 1.0, g_liftWavePos >= g_dist + 2.0);
    } else if (g_dist > g_dotWavePos + 1.0) {
        // Before dot wave: invisible
        gsplatMakeRound(covA, covB, 0.0);
        return;
    } else if (g_dist > g_dotWavePos - 1.0) {
        // Dot wave front: scale from 0 to 0.1 with 2x peak at center
        let distToWave = abs(g_dist - g_dotWavePos);
        scale = select(
            mix(0.0, 0.1, smoothstep(g_dotWavePos + 1.0, g_dotWavePos - 1.0, g_dist)),
            mix(0.1, 0.2, 1.0 - distToWave * 2.0),
            distToWave < 0.5
        );
    } else {
        // After dot wave, before lift: small dots
        scale = 0.1;
    }
    
    // Apply scale to covariance
    if (scale >= 1.0) {
        // Fully revealed: original shape and size (no-op)
        return;
    } else if (isLiftWave) {
        // Lift wave: lerp from round dots to original shape
        let t = (scale - 0.1) * 1.111111; // normalize [0.1, 1.0] to [0, 1]
        let dotSize = scale * 0.05;
        let originalSize = gsplatExtractSize(*covA, *covB);
        let finalSize = mix(dotSize, originalSize, t);
        
        // Lerp between round and scaled original
        let origCovA = *covA * (scale * scale);
        let origCovB = *covB * (scale * scale);
        gsplatMakeRound(covA, covB, finalSize);
        *covA = mix(*covA, origCovA, t);
        *covB = mix(*covB, origCovB, t);
    } else {
        // Dot phase: round with absolute size, but don't make small splats larger
        let originalSize = gsplatExtractSize(*covA, *covB);
        gsplatMakeRound(covA, covB, min(scale * 0.05, originalSize));
    }
}

fn modifyColor(center: vec3f, color: ptr<function, vec4f>) {
    // Use shared globals
    if (g_dist > uniform.uEndRadius) {
        return;
    }
    
    // Lift wave tint takes priority (active during lift)
    if (g_liftTime > 0.0 && g_dist >= g_liftWavePos - 1.5 && g_dist <= g_liftWavePos + 0.5) {
        let distToLift = abs(g_dist - g_liftWavePos);
        let liftIntensity = smoothstep(1.5, 0.0, distToLift);
        (*color) = vec4f((*color).rgb + uniform.uWaveTint * liftIntensity, (*color).a);
    }
    // Dot wave tint (active in dot phase, but not where lift wave is active)
    else if (g_dist <= g_dotWavePos && (g_liftTime <= 0.0 || g_dist > g_liftWavePos + 0.5)) {
        let distToDot = abs(g_dist - g_dotWavePos);
        let dotIntensity = smoothstep(1.0, 0.0, distToDot);
        (*color) = vec4f((*color).rgb + uniform.uDotTint * dotIntensity, (*color).a);
    }
}
`;
/**
 * Radial reveal effect for gaussian splats.
 * Creates two waves emanating from a center point:
 * 1. Dot wave: Small colored dots appear progressively
 * 2. Lift wave: Particles lift up, get highlighted, then settle to original state
 *
 * @example
 * // Add the script to a gsplat entity
 * entity.addComponent('script');
 * entity.script.create(GsplatRevealRadial, {
 *     attributes: {
 *         center: new pc.Vec3(0, 0, 0),
 *         speed: 2,
 *         delay: 1,
 *         oscillationIntensity: 0.2
 *     }
 * });
 */
class GsplatRevealRadial extends GsplatShaderEffect {
    static scriptName = 'gsplatRevealRadial';
    // Reusable arrays for uniform updates
    _centerArray = [0, 0, 0];
    _dotTintArray = [0, 0, 0];
    _waveTintArray = [0, 0, 0];
    /**
     * Origin point for radial waves
     * @attribute
     */
    center = new Vec3(0, 0, 0);
    /**
     * Base wave speed in units/second
     * @attribute
     * @range [0, 10]
     */
    speed = 1;
    /**
     * Speed increase over time
     * @attribute
     * @range [0, 5]
     */
    acceleration = 5;
    /**
     * Time offset before lift wave starts (seconds)
     * @attribute
     * @range [0, 10]
     */
    delay = 2;
    /**
     * Additive color for initial dots
     * @attribute
     */
    dotTint = new Color(0, 1, 1);
    /**
     * Additive color for lift wave highlight
     * @attribute
     */
    waveTint = new Color(5, 0, 0);
    /**
     * Position oscillation strength
     * @attribute
     * @range [0, 1]
     */
    oscillationIntensity = 0.1;
    /**
     * Distance at which to disable effect for performance
     * @attribute
     * @range [0, 500]
     */
    endRadius = 25;
    getShaderGLSL() {
        return shaderGLSL$2;
    }
    getShaderWGSL() {
        return shaderWGSL$2;
    }
    updateEffect(effectTime, dt) {
        // Update uniforms from attributes
        this.setUniform('uTime', effectTime);
        this._centerArray[0] = this.center.x;
        this._centerArray[1] = this.center.y;
        this._centerArray[2] = this.center.z;
        this.setUniform('uCenter', this._centerArray);
        this.setUniform('uSpeed', this.speed);
        this.setUniform('uAcceleration', this.acceleration);
        this.setUniform('uDelay', this.delay);
        this._dotTintArray[0] = this.dotTint.r;
        this._dotTintArray[1] = this.dotTint.g;
        this._dotTintArray[2] = this.dotTint.b;
        this.setUniform('uDotTint', this._dotTintArray);
        this._waveTintArray[0] = this.waveTint.r;
        this._waveTintArray[1] = this.waveTint.g;
        this._waveTintArray[2] = this.waveTint.b;
        this.setUniform('uWaveTint', this._waveTintArray);
        this.setUniform('uOscillationIntensity', this.oscillationIntensity);
        this.setUniform('uEndRadius', this.endRadius);
        // Check if effect is complete and disable if so
        if (this.isEffectComplete()) {
            console.log('Radial effect completed, disabling');
            this.enabled = false;
            return;
        }
    }
    /**
     * Calculates when the lift wave reaches endRadius.
     * @returns {number} Time in seconds when the effect completes
     */
    getCompletionTime() {
        const liftStartTime = this.delay;
        // Solve for when wave reaches endRadius
        // endRadius = speed * t + 0.5 * acceleration * t²
        if (this.acceleration === 0) {
            // No acceleration: simple linear motion
            return liftStartTime + (this.endRadius / this.speed);
        }
        // With acceleration: use quadratic formula
        // 0.5 * a * t² + v * t - d = 0
        // t = (-v + sqrt(v² + 2ad)) / a
        const discriminant = this.speed * this.speed + 2 * this.acceleration * this.endRadius;
        if (discriminant < 0) {
            // Should not happen with positive values, but handle gracefully
            return Infinity;
        }
        const t = (-this.speed + Math.sqrt(discriminant)) / this.acceleration;
        return liftStartTime + t;
    }
    /**
     * Checks if the reveal effect has completed (lift wave reached endRadius).
     * @returns {boolean} True if effect is complete
     */
    isEffectComplete() {
        return this.effectTime >= this.getCompletionTime();
    }
}

const shaderGLSL$1 = /* glsl */ `
uniform float uTime;
uniform vec3 uCenter;
uniform float uDistance;
uniform float uSpeed;
uniform float uAcceleration;
uniform float uFlightTime;
uniform float uRainSize;
uniform float uRotation;
uniform vec3 uFallTint;
uniform float uFallTintIntensity;
uniform vec3 uHitTint;
uniform float uHitDuration;
uniform float uEndRadius;

// Shared globals (initialized once per vertex)
float g_dist2D;
float g_dist3D;
float g_tStart;
float g_tLand;

// Solve: distance = speed * t + 0.5 * acceleration * t²
float solveWaveTime(float dist) {
    if (uAcceleration == 0.0) {
        return dist / uSpeed;
    } else {
        // Quadratic formula: t = (-v + sqrt(v² + 2ad)) / a
        float discriminant = uSpeed * uSpeed + 2.0 * uAcceleration * dist;
        return (-uSpeed + sqrt(max(discriminant, 0.0))) / uAcceleration;
    }
}

void initShared(vec3 center) {
    vec2 center2D = center.xz;
    vec2 origin2D = uCenter.xz;
    g_dist2D = length(center2D - origin2D);
    g_dist3D = length(center - uCenter);
    g_tStart = solveWaveTime(g_dist2D);
    g_tLand = g_tStart + uFlightTime;
}

void modifyCenter(inout vec3 center) {
    vec3 originalCenter = center;
    initShared(center);
    
    // Check if animation is complete (after landing transition)
    float timeSinceLanding = uTime - g_tLand;
    if (timeSinceLanding >= 0.5) return; // Effect complete, no modifications
    
    // Early exit optimization during animation
    if (g_dist3D > uEndRadius) return;
    
    // If not started yet, do nothing (will be invisible)
    if (uTime < g_tStart) return;
    
    // If falling: interpolate Y from elevated to original and apply rotation
    if (uTime < g_tLand) {
        float fallProgress = (uTime - g_tStart) / (g_tLand - g_tStart);
        
        // Vertical movement
        center.y += uDistance * (1.0 - fallProgress);
        
        // Rotation around Y axis through uCenter
        float angle = fallProgress * uRotation * 6.283185; // uRotation * 2π
        vec3 offset = originalCenter - uCenter;
        float cosAngle = cos(angle);
        float sinAngle = sin(angle);
        offset.x = originalCenter.x - uCenter.x;
        offset.z = originalCenter.z - uCenter.z;
        center.x = uCenter.x + offset.x * cosAngle - offset.z * sinAngle;
        center.z = uCenter.z + offset.x * sinAngle + offset.z * cosAngle;
    }
    // If landed: stay at original position (no change needed)
}

void modifyCovariance(vec3 originalCenter, vec3 modifiedCenter, inout vec3 covA, inout vec3 covB) {
    // Check if animation is complete (after landing transition)
    float timeSinceLanding = uTime - g_tLand;
    if (timeSinceLanding >= 0.5) return; // Effect complete, no modifications
    
    // Early exit for distant splats during animation
    if (g_dist3D > uEndRadius) {
        gsplatMakeRound(covA, covB, 0.0);
        return;
    }
    
    // Before 2D wave reaches: invisible
    if (uTime < g_tStart) {
        gsplatMakeRound(covA, covB, 0.0);
        return;
    }
    
    // During fall and transition after landing
    if (timeSinceLanding < 0.5) {
        // Still falling or transitioning
        float originalSize = gsplatExtractSize(covA, covB);
        
        if (timeSinceLanding < 0.0) {
            // Falling: small round dots
            gsplatMakeRound(covA, covB, min(uRainSize, originalSize));
        } else {
            // Landing transition: lerp from dots to original over 0.5s
            float t = timeSinceLanding * 2.0; // normalize [0, 0.5] to [0, 1]
            float size = mix(uRainSize, originalSize, t);
            
            // Lerp between round and original shape
            vec3 origCovA = covA;
            vec3 origCovB = covB;
            gsplatMakeRound(covA, covB, size);
            covA = mix(covA, origCovA, t);
            covB = mix(covB, origCovB, t);
        }
    }
    // After transition: original shape/size (no-op)
}

void modifyColor(vec3 center, inout vec4 color) {
    // Check if animation is complete
    float timeSinceLanding = uTime - g_tLand;
    if (timeSinceLanding >= uHitDuration) return; // Effect complete, no modifications
    
    // Early exit for distant splats during animation
    if (g_dist3D > uEndRadius) return;
    
    // Before wave reaches: no color change (invisible anyway)
    if (uTime < g_tStart) return;
    
    if (timeSinceLanding < 0.0) {
        // Falling: blend between original and fall tint
        color.rgb = mix(color.rgb, uFallTint, uFallTintIntensity);
    } else if (timeSinceLanding < uHitDuration) {
        // Landing: apply hit tint, fade out
        float fadeOut = 1.0 - (timeSinceLanding / uHitDuration);
        color.rgb += uHitTint * fadeOut;
    }
    // After hit duration: original color (no change)
}
`;
const shaderWGSL$1 = /* wgsl */ `
uniform uTime: f32;
uniform uCenter: vec3f;
uniform uDistance: f32;
uniform uSpeed: f32;
uniform uAcceleration: f32;
uniform uFlightTime: f32;
uniform uRainSize: f32;
uniform uRotation: f32;
uniform uFallTint: vec3f;
uniform uFallTintIntensity: f32;
uniform uHitTint: vec3f;
uniform uHitDuration: f32;
uniform uEndRadius: f32;

// Shared globals (initialized once per vertex)
var<private> g_dist2D: f32;
var<private> g_dist3D: f32;
var<private> g_tStart: f32;
var<private> g_tLand: f32;

// Solve: distance = speed * t + 0.5 * acceleration * t²
fn solveWaveTime(dist: f32) -> f32 {
    if (uniform.uAcceleration == 0.0) {
        return dist / uniform.uSpeed;
    } else {
        // Quadratic formula: t = (-v + sqrt(v² + 2ad)) / a
        let discriminant = uniform.uSpeed * uniform.uSpeed + 2.0 * uniform.uAcceleration * dist;
        return (-uniform.uSpeed + sqrt(max(discriminant, 0.0))) / uniform.uAcceleration;
    }
}

fn initShared(center: vec3f) {
    let center2D = center.xz;
    let origin2D = uniform.uCenter.xz;
    g_dist2D = length(center2D - origin2D);
    g_dist3D = length(center - uniform.uCenter);
    g_tStart = solveWaveTime(g_dist2D);
    g_tLand = g_tStart + uniform.uFlightTime;
}

fn modifyCenter(center: ptr<function, vec3f>) {
    let originalCenter = *center;
    initShared(*center);
    
    // Check if animation is complete (after landing transition)
    let timeSinceLanding = uniform.uTime - g_tLand;
    if (timeSinceLanding >= 0.5) {
        return; // Effect complete, no modifications
    }
    
    // Early exit optimization during animation
    if (g_dist3D > uniform.uEndRadius) {
        return;
    }
    
    // If not started yet, do nothing (will be invisible)
    if (uniform.uTime < g_tStart) {
        return;
    }
    
    // If falling: interpolate Y from elevated to original and apply rotation
    if (uniform.uTime < g_tLand) {
        let fallProgress = (uniform.uTime - g_tStart) / (g_tLand - g_tStart);
        
        // Vertical movement
        (*center).y += uniform.uDistance * (1.0 - fallProgress);
        
        // Rotation around Y axis through uCenter
        let angle = fallProgress * uniform.uRotation * 6.283185; // uRotation * 2π
        let offset = originalCenter - uniform.uCenter;
        let cosAngle = cos(angle);
        let sinAngle = sin(angle);
        let offsetX = originalCenter.x - uniform.uCenter.x;
        let offsetZ = originalCenter.z - uniform.uCenter.z;
        (*center).x = uniform.uCenter.x + offsetX * cosAngle - offsetZ * sinAngle;
        (*center).z = uniform.uCenter.z + offsetX * sinAngle + offsetZ * cosAngle;
    }
    // If landed: stay at original position (no change needed)
}

fn modifyCovariance(originalCenter: vec3f, modifiedCenter: vec3f, covA: ptr<function, vec3f>, covB: ptr<function, vec3f>) {
    // Check if animation is complete (after landing transition)
    let timeSinceLanding = uniform.uTime - g_tLand;
    if (timeSinceLanding >= 0.5) {
        return; // Effect complete, no modifications
    }
    
    // Early exit for distant splats during animation
    if (g_dist3D > uniform.uEndRadius) {
        gsplatMakeRound(covA, covB, 0.0);
        return;
    }
    
    // Before 2D wave reaches: invisible
    if (uniform.uTime < g_tStart) {
        gsplatMakeRound(covA, covB, 0.0);
        return;
    }
    
    // During fall and transition after landing
    if (timeSinceLanding < 0.5) {
        // Still falling or transitioning
        let originalSize = gsplatExtractSize(*covA, *covB);
        
        if (timeSinceLanding < 0.0) {
            // Falling: small round dots
            gsplatMakeRound(covA, covB, min(uniform.uRainSize, originalSize));
        } else {
            // Landing transition: lerp from dots to original over 0.5s
            let t = timeSinceLanding * 2.0; // normalize [0, 0.5] to [0, 1]
            let size = mix(uniform.uRainSize, originalSize, t);
            
            // Lerp between round and original shape
            let origCovA = *covA;
            let origCovB = *covB;
            gsplatMakeRound(covA, covB, size);
            *covA = mix(*covA, origCovA, t);
            *covB = mix(*covB, origCovB, t);
        }
    }
    // After transition: original shape/size (no-op)
}

fn modifyColor(center: vec3f, color: ptr<function, vec4f>) {
    // Check if animation is complete
    let timeSinceLanding = uniform.uTime - g_tLand;
    if (timeSinceLanding >= uniform.uHitDuration) {
        return; // Effect complete, no modifications
    }
    
    // Early exit for distant splats during animation
    if (g_dist3D > uniform.uEndRadius) {
        return;
    }
    
    // Before wave reaches: no color change (invisible anyway)
    if (uniform.uTime < g_tStart) {
        return;
    }
    
    if (timeSinceLanding < 0.0) {
        // Falling: blend between original and fall tint
        (*color) = vec4f(mix((*color).rgb, uniform.uFallTint, uniform.uFallTintIntensity), (*color).a);
    } else if (timeSinceLanding < uniform.uHitDuration) {
        // Landing: apply hit tint, fade out
        let fadeOut = 1.0 - (timeSinceLanding / uniform.uHitDuration);
        (*color) = vec4f((*color).rgb + uniform.uHitTint * fadeOut, (*color).a);
    }
    // After hit duration: original color (no change)
}
`;
/**
 * Rain reveal effect for gaussian splats.
 * Splats appear as small dots at an elevated position and fall down to land
 * when an expanding 3D sphere wave reaches them.
 *
 * @example
 * // Add the script to a gsplat entity
 * entity.addComponent('script');
 * const rainScript = entity.script.create(GsplatRevealRain);
 * rainScript.center.set(0, 0, 0);
 * rainScript.distance = 5;
 * rainScript.speed = 3;
 */
class GsplatRevealRain extends GsplatShaderEffect {
    static scriptName = 'gsplatRevealRain';
    // Reusable arrays for uniform updates
    _centerArray = [0, 0, 0];
    _fallTintArray = [0, 0, 0];
    _hitTintArray = [0, 0, 0];
    /**
     * Origin point for the wave
     * @attribute
     */
    center = new Vec3(0, 0, 0);
    /**
     * Elevation above target position where splats start
     * @attribute
     * @range [0, 50]
     */
    distance = 30;
    /**
     * Wave speed in units/second
     * @attribute
     * @range [0, 10]
     */
    speed = 2;
    /**
     * Speed increase over time
     * @attribute
     * @range [0, 5]
     */
    acceleration = 0;
    /**
     * Duration of fall in seconds
     * @attribute
     * @range [0.1, 5]
     */
    flightTime = 2;
    /**
     * Size of particles while falling
     * @attribute
     * @range [0, 0.1]
     */
    rainSize = 0.015;
    /**
     * Rotation amount during fall (fraction of full circle, 0.9 = 90%)
     * @attribute
     * @range [0, 2]
     */
    rotation = 0.9;
    /**
     * Color during fall
     * @attribute
     */
    fallTint = new Color(0, 1, 1);
    /**
     * Blend intensity between original color and fall tint (0=original, 1=full tint)
     * @attribute
     * @range [0, 1]
     */
    fallTintIntensity = 0.2;
    /**
     * Additive color on landing (flash)
     * @attribute
     */
    hitTint = new Color(2, 0, 0);
    /**
     * Duration of hit tint flash in seconds
     * @attribute
     * @range [0, 2]
     */
    hitDuration = 0.5;
    /**
     * Distance at which to disable effect for performance
     * @attribute
     * @range [0, 500]
     */
    endRadius = 25;
    getShaderGLSL() {
        return shaderGLSL$1;
    }
    getShaderWGSL() {
        return shaderWGSL$1;
    }
    updateEffect(effectTime, dt) {
        // Update all uniforms first
        this.setUniform('uTime', effectTime);
        this._centerArray[0] = this.center.x;
        this._centerArray[1] = this.center.y;
        this._centerArray[2] = this.center.z;
        this.setUniform('uCenter', this._centerArray);
        this.setUniform('uDistance', this.distance);
        this.setUniform('uSpeed', this.speed);
        this.setUniform('uAcceleration', this.acceleration);
        this.setUniform('uFlightTime', this.flightTime);
        this.setUniform('uRainSize', this.rainSize);
        this.setUniform('uRotation', this.rotation);
        this._fallTintArray[0] = this.fallTint.r;
        this._fallTintArray[1] = this.fallTint.g;
        this._fallTintArray[2] = this.fallTint.b;
        this.setUniform('uFallTint', this._fallTintArray);
        this.setUniform('uFallTintIntensity', this.fallTintIntensity);
        this._hitTintArray[0] = this.hitTint.r;
        this._hitTintArray[1] = this.hitTint.g;
        this._hitTintArray[2] = this.hitTint.b;
        this.setUniform('uHitTint', this._hitTintArray);
        this.setUniform('uHitDuration', this.hitDuration);
        this.setUniform('uEndRadius', this.endRadius);
        // Check if effect is complete after updating uniforms
        // This ensures the last frame is rendered with correct values
        if (this.isEffectComplete()) {
            console.log('Rain effect completed, disabling');
            this.enabled = false;
            return;
        }
    }
    /**
     * Calculate when the effect is complete.
     * Effect completes when the furthest splat within endRadius has finished animating.
     * @returns {boolean} True if effect is complete
     */
    isEffectComplete() {
        // Calculate time for furthest splat within endRadius
        let maxTStart;
        if (this.acceleration === 0) {
            maxTStart = this.endRadius / this.speed;
        }
        else {
            // Quadratic formula: t = (-v + sqrt(v² + 2ad)) / a
            const discriminant = this.speed * this.speed + 2.0 * this.acceleration * this.endRadius;
            maxTStart = (-this.speed + Math.sqrt(Math.max(discriminant, 0.0))) / this.acceleration;
        }
        const maxTLand = maxTStart + this.flightTime;
        const maxCompletionTime = maxTLand + Math.max(0.5, this.hitDuration);
        return this.effectTime >= maxCompletionTime;
    }
}

const shaderGLSL = /* glsl */ `
uniform float uTime;
uniform vec3 uCenter;
uniform float uCurrentLightRadius;
uniform float uFadeWidth;
uniform int uTransitionEffect;
uniform vec2 uViewport;
uniform mat4 uModelViewMatrix;
uniform mat4 uProjectionMatrix;

// Hash function for per-splat randomization
float hash(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

void modifyCenter(inout vec3 center) {
    // 平滑过渡效果不修改中心点位置
}

void modifyCovariance(vec3 originalCenter, vec3 modifiedCenter, inout vec3 covA, inout vec3 covB) {
    // 计算到过渡中心的距离
    float distanceToCenter = length(originalCenter - uCenter);
    
    // 计算渐变区域
    float fadeStart = uCurrentLightRadius - uFadeWidth;
    
    if (distanceToCenter >= uCurrentLightRadius) {
        // 完全隐藏：超出半径的点
        gsplatMakeRound(covA, covB, 0.0);
        return;
    } else if (distanceToCenter < fadeStart) {
        // 完全显示区域：保持原始形状
        return;
    }
    // 过渡区域：保持原始形状，透明度在 modifyColor 中处理
}

void modifyColor(vec3 center, inout vec4 color) {
    // 计算到过渡中心的距离
    float distanceToCenter = length(center - uCenter);
    
    // 计算渐变区域
    float fadeStart = uCurrentLightRadius - uFadeWidth;
    
    if (distanceToCenter >= uCurrentLightRadius) {
        // 完全隐藏
        color.a = 0.0;
    } else if (distanceToCenter >= fadeStart) {
        // 过渡区域：应用平滑透明度渐变
        float fadeProgress = (distanceToCenter - fadeStart) / uFadeWidth;
        color.a *= (1.0 - smoothstep(0.0, 1.0, fadeProgress));
    }
    // 完全显示区域：保持原始颜色和透明度
}
`;
const shaderWGSL = /* wgsl */ `
uniform uTime: f32;
uniform uCenter: vec3f;
uniform uCurrentLightRadius: f32;
uniform uFadeWidth: f32;
uniform uTransitionEffect: i32;
uniform uViewport: vec2f;
uniform uModelViewMatrix: mat4x4f;
uniform uProjectionMatrix: mat4x4f;

// Hash function for per-splat randomization
fn hash(p: vec3f) -> f32 {
    return fract(sin(dot(p, vec3f(127.1, 311.7, 74.7))) * 43758.5453);
}

fn modifyCenter(center: ptr<function, vec3f>) {
    // 平滑过渡效果不修改中心点位置
}

fn modifyCovariance(originalCenter: vec3f, modifiedCenter: vec3f, covA: ptr<function, vec3f>, covB: ptr<function, vec3f>) {
    // 计算到过渡中心的距离
    let distanceToCenter = length(originalCenter - uniform.uCenter);
    
    // 计算渐变区域
    let fadeStart = uniform.uCurrentLightRadius - uniform.uFadeWidth;
    
    if (distanceToCenter >= uniform.uCurrentLightRadius) {
        // 完全隐藏：超出半径的点
        gsplatMakeRound(covA, covB, 0.0);
        return;
    } else if (distanceToCenter < fadeStart) {
        // 完全显示区域：保持原始形状
        return;
    }
    // 过渡区域：保持原始形状，透明度在 modifyColor 中处理
}

fn modifyColor(center: vec3f, color: ptr<function, vec4f>) {
    // 计算到过渡中心的距离
    let distanceToCenter = length(center - uniform.uCenter);
    
    // 计算渐变区域
    let fadeStart = uniform.uCurrentLightRadius - uniform.uFadeWidth;
    
    if (distanceToCenter >= uniform.uCurrentLightRadius) {
        // 完全隐藏
        (*color).a = 0.0;
    } else if (distanceToCenter >= fadeStart) {
        // 过渡区域：应用平滑透明度渐变
        let fadeProgress = (distanceToCenter - fadeStart) / uniform.uFadeWidth;
        (*color).a *= (1.0 - smoothstep(0.0, 1.0, fadeProgress));
    }
    // 完全显示区域：保持原始颜色和透明度
}
`;
/**
 * 平滑过渡显示效果，用于 Gaussian Splats
 * 从中心点向外扩散，创建一个圆形的平滑过渡边界
 *
 * 基于 SplatVertex.glsl 中的 transitionEffect == 1 实现
 *
 * @example
 * // 添加脚本到 gsplat entity
 * const smoothEffect = new GsplatRevealSmooth();
 * smoothEffect.center = new Vector3(0, 0, 0);
 * smoothEffect.currentLightRadius = 10;
 * smoothEffect.fadeWidthRatio = 0.1;
 * smoothEffect.applyToMaterial(splatMaterial);
 */
class GsplatRevealSmooth extends GsplatShaderEffect {
    static scriptName = 'gsplatRevealSmooth';
    // 可重用数组用于 uniform 更新
    _centerArray = [0, 0, 0];
    /**
     * 过渡效果的中心点
     * @attribute
     */
    center = new Vec3(0, 0, 0);
    /**
     * 当前可见半径
     * @attribute
     * @range [0, 100]
     */
    currentLightRadius = 10;
    /**
     * 渐变宽度比例（相对于 currentLightRadius）
     * @attribute
     * @range [0, 1]
     */
    fadeWidthRatio = 0.1;
    /**
     * 过渡效果类型
     * 1: 圆形扩散（默认）
     * 2: 从中心向外
     * 3: 水平扩散
     * 4: 垂直扩散
     * @attribute
     * @range [1, 4]
     */
    transitionEffect = 1;
    /**
     * 半径增长速度（单位/秒）
     * @attribute
     * @range [0, 50]
     */
    growthSpeed = 5;
    /**
     * 最大半径（效果完成时的半径）
     * @attribute
     * @range [0, 500]
     */
    maxRadius = 50;
    getShaderGLSL() {
        return shaderGLSL;
    }
    getShaderWGSL() {
        return shaderWGSL;
    }
    updateEffect(effectTime, dt) {
        // 根据时间自动增长半径
        if (this.growthSpeed > 0) {
            this.currentLightRadius = Math.min(effectTime * this.growthSpeed, this.maxRadius);
        }
        // 更新 uniforms
        this.setUniform('uTime', effectTime);
        this._centerArray[0] = this.center.x;
        this._centerArray[1] = this.center.y;
        this._centerArray[2] = this.center.z;
        this.setUniform('uCenter', this._centerArray);
        this.setUniform('uCurrentLightRadius', this.currentLightRadius);
        // 计算渐变宽度
        const fadeWidth = this.currentLightRadius * this.fadeWidthRatio;
        this.setUniform('uFadeWidth', fadeWidth);
        this.setUniform('uTransitionEffect', this.transitionEffect);
        // 检查效果是否完成
        if (this.isEffectComplete()) {
            console.log('Smooth transition effect completed, disabling');
            this.enabled = false;
            return;
        }
    }
    /**
     * 计算效果完成时间
     * @returns {number} 效果完成的时间（秒）
     */
    getCompletionTime() {
        if (this.growthSpeed === 0) {
            return Infinity;
        }
        return this.maxRadius / this.growthSpeed;
    }
    /**
     * 检查过渡效果是否完成
     * @returns {boolean} 如果效果完成返回 true
     */
    isEffectComplete() {
        return this.currentLightRadius >= this.maxRadius;
    }
}

// import { GsplatRevealRadial } from 'playcanvas/scripts/esm/gsplat/reveal-radial.mjs';
// import { GsplatRevealRain } from 'playcanvas/scripts/esm/gsplat/reveal-rain.mjs';
/**
 * Script-based Reveal Controller - 基于原始reveal.example.mjs的实现
 * 使用createRadialScript等方法来创建和管理reveal scripts
 */
class RevealController {
    gsplatEntity = null;
    config;
    currentScript = null;
    global;
    constructor(global, bbox, gsplatEntity) {
        this.global = global;
        const { settings, events, state } = global;
        this.gsplatEntity = gsplatEntity;
        // Check if revealEffect is empty or has no type
        const hasRevealEffect = settings.revealEffect &&
            Object.keys(settings.revealEffect).length > 0 &&
            settings.revealEffect.type;
        if (!hasRevealEffect) {
            console.log('No reveal effect specified, skipping reveal initialization.');
            state.hasRevealEffect = false;
            return;
        }
        this.config = {
            type: settings.revealEffect.type ?? 'radial',
            radius: settings.revealEffect.radius ?? 10,
            autoStart: settings.revealEffect.autoStart ?? true
        };
        console.log('RevealController initialized with config:', this.config);
        // Set state to indicate reveal effect is available
        state.hasRevealEffect = true;
        // 监听配置变化
        events.on('revealConfigChanged', (newConfig) => {
            console.log('Reveal config changed:', newConfig);
            this.updateConfig(newConfig);
        });
        // 监听重启请求
        events.on('revealRestart', () => {
            console.log('Reveal restart requested via event');
            this.restart();
        });
        // 使用相机的 look target 作为默认 reveal center，如果没有则使用 bbox.center
        const cameraTarget = settings.cameras?.[0]?.initial?.target;
        const revealCenter = cameraTarget ? cameraTarget : bbox.center.toArray();
        this.setRevealCenter(revealCenter);
        // 创建初始效果
        this.createEffect(this.config.type);
    }
    /**
     * 创建radial reveal script - 类似原始实现中的createRadialScript
     */
    createRadialScript() {
        if (!this.gsplatEntity || !this.gsplatEntity.script) {
            console.warn('Cannot create radial script - entity or script component not ready');
            return null;
        }
        console.log('Creating radial reveal script');
        try {
            const script = this.gsplatEntity.script.create(GsplatRevealRadial);
            if (script) {
                // 配置script属性 - 类似原始实现
                script.speed = 5;
                script.acceleration = 0;
                script.delay = 0.5;
                script.dotTint.set(0, 1, 1); // Cyan
                script.waveTint.set(1, 0.5, 0); // Orange
                script.oscillationIntensity = 0.2;
                script.endRadius = this.config.radius;
                // 初始状态设为禁用，等待手动启动
                script.enabled = true;
                console.log('Radial script created with config:', {
                    center: script.center,
                    endRadius: script.endRadius,
                    enabled: script.enabled
                });
            }
            return script;
        }
        catch (error) {
            console.error('Failed to create radial script:', error);
            return null;
        }
    }
    /**
     * 创建rain reveal script - 类似原始实现中的createRainScript
     */
    createRainScript() {
        if (!this.gsplatEntity || !this.gsplatEntity.script) {
            console.warn('Cannot create rain script - entity or script component not ready');
            return null;
        }
        console.log('Creating rain reveal script');
        try {
            const script = this.gsplatEntity.script.create(GsplatRevealRain);
            if (script) {
                // 配置script属性 - 类似原始实现
                script.distance = 30;
                script.speed = 3;
                script.acceleration = 0;
                script.flightTime = 2;
                script.rainSize = 0.015;
                script.rotation = 0.9; // 90% of full circle rotation during fall
                script.fallTint.set(0, 1, 1); // Cyan tint during fall
                script.fallTintIntensity = 0.2;
                script.hitTint.set(2, 0, 0); // Bright red flash on landing
                script.hitDuration = 0.5;
                script.endRadius = this.config.radius;
                // 初始状态设为禁用，等待手动启动
                script.enabled = true;
                console.log('Rain script created with config:', {
                    center: script.center,
                    endRadius: script.endRadius,
                    enabled: script.enabled
                });
            }
            return script;
        }
        catch (error) {
            console.error('Failed to create rain script:', error);
            return null;
        }
    }
    /**
     * 创建smooth reveal script
     */
    createSmoothScript() {
        if (!this.gsplatEntity || !this.gsplatEntity.script) {
            console.warn('Cannot create smooth script - entity or script component not ready');
            return null;
        }
        console.log('Creating smooth reveal script');
        try {
            const script = this.gsplatEntity.script.create(GsplatRevealSmooth);
            if (script) {
                // 配置script属性
                script.maxRadius = this.config.radius;
                // 初始状态设为禁用，等待手动启动
                script.enabled = true;
                console.log('Smooth script created with config:', {
                    center: script.center,
                    maxRadius: script.maxRadius
                });
            }
            return script;
        }
        catch (error) {
            console.error('Failed to create smooth script:', error);
            return null;
        }
    }
    /**
     * 创建指定类型的reveal效果 - 类似原始实现中的createEffect函数
     */
    createEffect(effectName) {
        if (!this.gsplatEntity || !this.config) {
            console.log('Cannot create effect - entity not ready or config not set');
            return;
        }
        console.log('Creating effect:', effectName, 'for entity:', this.gsplatEntity.name);
        console.log('GSplat entity details:', {
            hasGsplat: !!this.gsplatEntity.gsplat,
            hasScript: !!this.gsplatEntity.script,
            gsplatMaterial: this.gsplatEntity.gsplat?.material,
            gsplatUnified: this.gsplatEntity.gsplat?.unified
        });
        // 确保实体有script组件
        if (!this.gsplatEntity.script) {
            this.gsplatEntity.addComponent('script');
            console.log('Added script component to gsplat entity');
        }
        // 销毁现有的reveal scripts - 类似原始实现
        this.destroyAllRevealScripts();
        // 根据类型创建对应的script
        let script = null;
        switch (effectName) {
            case 'radial':
                script = this.createRadialScript();
                break;
            case 'rain':
                script = this.createRainScript();
                break;
            case 'smooth':
                script = this.createSmoothScript();
                break;
            default:
                console.warn('Unknown effect type:', effectName);
                script = this.createRadialScript();
        }
        this.currentScript = script;
        // 如果script创建成功
        if (script) {
            if (this.config.autoStart) {
                console.log('Auto-starting reveal effect by enabling script');
                setTimeout(() => {
                    if (script) {
                        script.enabled = true;
                        console.log('Script enabled, effect should start. Script details:', {
                            enabled: script.enabled,
                            initialized: script.initialized,
                            materialsApplied: script.materialsApplied?.size || 0
                        });
                    }
                }, 1000); // 增加延迟确保gsplat完全加载
            }
            else {
                console.log('Reveal effect created but not auto-started. Click "Start Reveal" button to begin.');
                script.enabled = false;
            }
        }
    }
    /**
     * 销毁所有reveal scripts
     */
    destroyAllRevealScripts() {
        if (!this.gsplatEntity || !this.gsplatEntity.script) {
            return;
        }
        console.log('Destroying all reveal scripts');
        try {
            // 销毁所有类型的reveal scripts
            this.gsplatEntity.script.destroy('gsplatRevealRadial');
            this.gsplatEntity.script.destroy('gsplatRevealRain');
            this.gsplatEntity.script.destroy('gsplatRevealSmooth');
            // 未来可以添加更多类型
        }
        catch (error) {
            console.warn('Error destroying reveal scripts:', error);
        }
        this.currentScript = null;
    }
    updateConfig(newConfig) {
        const oldType = this.config.type;
        Object.assign(this.config, newConfig);
        // Also update the settings object so UI can read it
        if (this.global.settings.revealEffect) {
            Object.assign(this.global.settings.revealEffect, newConfig);
        }
        console.log('Updated reveal config:', this.config);
        // 如果类型改变，重新创建效果
        if (newConfig.type && newConfig.type !== oldType) {
            this.createEffect(newConfig.type);
        }
        // 更新现有script的配置
        else if (this.currentScript) {
            this.updateCurrentScriptConfig(newConfig);
        }
    }
    /**
     * 更新当前script的配置
     */
    updateCurrentScriptConfig(newConfig) {
        if (!this.currentScript)
            return;
        console.log('Updating current script config');
        try {
            if (newConfig.radius !== undefined) {
                this.currentScript.setRadius?.(newConfig.radius) ||
                    (this.currentScript.radius = newConfig.radius);
            }
        }
        catch (error) {
            console.warn('Error updating script config:', error);
        }
    }
    restart() {
        if (!this.config) {
            console.log('No reveal config, cannot start reveal');
            return;
        }
        console.log('Manual start/restart reveal requested - recreating effect');
        // 临时设置 autoStart 为 true 以启动效果
        const originalAutoStart = this.config.autoStart;
        this.config.autoStart = true;
        // 重新创建效果
        this.createEffect(this.config.type);
        // 恢复原始设置
        this.config.autoStart = originalAutoStart;
    }
    // 公共方法
    isRevealActive() {
        return this.currentScript?.enabled || false;
    }
    getProgress() {
        if (!this.currentScript || !this.config) {
            return this.config ? 1 : 0;
        }
        try {
            return this.currentScript.getProgress?.() || 0;
        }
        catch (error) {
            return 0;
        }
    }
    setRevealCenter(center) {
        if (!this.config) {
            console.warn('Cannot set reveal center - no config');
            return;
        }
        console.log('Reveal center set to:', center);
        // 更新当前script的中心点
        if (this.currentScript) {
            try {
                if (this.currentScript.setCenter) {
                    this.currentScript.setCenter(center);
                }
                else if (this.currentScript.center) {
                    this.currentScript.center.copy(center);
                }
            }
            catch (error) {
                console.warn('Error setting reveal center:', error);
            }
        }
    }
    getCurrentScript() {
        return this.currentScript;
    }
    destroy() {
        console.log('Destroying RevealController');
        this.destroyAllRevealScripts();
    }
}

class CameraPathVisualizer {
    app;
    rootEntity;
    pathEntity = null;
    keyframeEntities = [];
    directionEntities = [];
    options;
    constructor(app, options = {}) {
        this.app = app;
        // Default options
        this.options = {
            pathColor: options.pathColor || new Color(0, 1, 1, 1),
            keyframeColor: options.keyframeColor || new Color(1, 0.5, 0, 1),
            directionColor: options.directionColor || new Color(1, 1, 0, 1),
            pathWidth: options.pathWidth || 0.05,
            keyframeSize: options.keyframeSize || 0.2,
            directionLength: options.directionLength || 1.0,
            showPath: options.showPath !== false,
            showKeyframes: options.showKeyframes !== false,
            showDirections: options.showDirections !== false,
            pathResolution: options.pathResolution || 100
        };
        // Create root entity
        this.rootEntity = new Entity('CameraPathVisualizer');
        this.app.root.addChild(this.rootEntity);
    }
    visualize(animTrack) {
        this.clear();
        const { keyframes, duration, frameRate, smoothness } = animTrack;
        const { times, values } = keyframes;
        const { position, target } = values;
        // Build spline for smooth path
        const points = [];
        for (let i = 0; i < times.length; i++) {
            points.push(position[i * 3], position[i * 3 + 1], position[i * 3 + 2]);
            points.push(target[i * 3], target[i * 3 + 1], target[i * 3 + 2]);
        }
        const extra = (duration === times[times.length - 1] / frameRate) ? 1 : 0;
        const spline = CubicSpline.fromPointsLooping((duration + extra) * frameRate, times, points, smoothness);
        // Visualize path
        if (this.options.showPath) {
            this.createPathLine(spline, duration * frameRate);
        }
        // Visualize keyframes
        if (this.options.showKeyframes) {
            for (let i = 0; i < times.length; i++) {
                const pos = new Vec3(position[i * 3], position[i * 3 + 1], position[i * 3 + 2]);
                this.createKeyframeMarker(pos, i);
            }
        }
        // Visualize directions
        if (this.options.showDirections) {
            for (let i = 0; i < times.length; i++) {
                const pos = new Vec3(position[i * 3], position[i * 3 + 1], position[i * 3 + 2]);
                const tgt = new Vec3(target[i * 3], target[i * 3 + 1], target[i * 3 + 2]);
                this.createDirectionArrow(pos, tgt, i);
            }
        }
    }
    createPathLine(spline, totalFrames) {
        const resolution = this.options.pathResolution;
        const positions = [];
        const result = [];
        for (let i = 0; i <= resolution; i++) {
            const t = (i / resolution) * totalFrames;
            spline.evaluate(t, result);
            if (result.every(isFinite)) {
                positions.push(result[0], result[1], result[2]);
            }
        }
        // Create line mesh
        const mesh = this.createLineMesh(positions);
        // Create material
        const material = new StandardMaterial();
        material.diffuse = this.options.pathColor;
        material.emissive = this.options.pathColor;
        material.emissiveIntensity = 0.5;
        material.update();
        // Create entity
        this.pathEntity = new Entity('CameraPath');
        this.pathEntity.addComponent('render', {
            type: 'asset',
            meshInstances: [new MeshInstance(mesh, material)]
        });
        this.rootEntity.addChild(this.pathEntity);
    }
    createLineMesh(positions) {
        const vertexCount = positions.length / 3;
        const indices = [];
        for (let i = 0; i < vertexCount - 1; i++) {
            indices.push(i, i + 1);
        }
        const mesh = new Mesh(this.app.graphicsDevice);
        mesh.setPositions(positions);
        mesh.setIndices(indices);
        mesh.update();
        return mesh;
    }
    createKeyframeMarker(position, index) {
        const material = new StandardMaterial();
        material.diffuse = this.options.keyframeColor;
        material.emissive = this.options.keyframeColor;
        material.emissiveIntensity = 0.7;
        material.update();
        const entity = new Entity(`Keyframe_${index}`);
        entity.addComponent('render', {
            type: 'sphere',
            material: material
        });
        const size = this.options.keyframeSize;
        entity.setLocalScale(size, size, size);
        entity.setPosition(position);
        this.rootEntity.addChild(entity);
        this.keyframeEntities.push(entity);
    }
    createDirectionArrow(from, to, index) {
        const direction = new Vec3().sub2(to, from).normalize();
        const length = this.options.directionLength;
        const endPoint = new Vec3().add2(from, direction.mulScalar(length));
        // Create arrow line
        const positions = [
            from.x, from.y, from.z,
            endPoint.x, endPoint.y, endPoint.z
        ];
        const mesh = this.createLineMesh(positions);
        const material = new StandardMaterial();
        material.diffuse = this.options.directionColor;
        material.emissive = this.options.directionColor;
        material.emissiveIntensity = 0.6;
        material.update();
        const entity = new Entity(`Direction_${index}`);
        entity.addComponent('render', {
            type: 'asset',
            meshInstances: [new MeshInstance(mesh, material)]
        });
        this.rootEntity.addChild(entity);
        this.directionEntities.push(entity);
        // Create arrow head (small cone)
        this.createArrowHead(endPoint, direction, material, index);
    }
    createArrowHead(position, direction, material, index) {
        const entity = new Entity(`ArrowHead_${index}`);
        entity.addComponent('render', {
            type: 'cone',
            material: material
        });
        const size = this.options.keyframeSize * 0.5;
        entity.setLocalScale(size, size * 1.5, size);
        entity.setPosition(position);
        // Orient cone to point in direction
        // Cone's default orientation is Y-up, we need to rotate it to point along direction
        const targetPoint = new Vec3().add2(position, direction);
        // Use lookAt with world up vector
        // The cone will point from position towards targetPoint
        entity.lookAt(targetPoint);
        // Rotate 90 degrees around X axis because cone points up by default
        // but we want it to point forward
        entity.rotateLocal(-90, 0, 0);
        this.rootEntity.addChild(entity);
        this.directionEntities.push(entity);
    }
    setVisible(visible) {
        this.rootEntity.enabled = visible;
    }
    setPathVisible(visible) {
        if (this.pathEntity) {
            this.pathEntity.enabled = visible;
        }
    }
    setKeyframesVisible(visible) {
        this.keyframeEntities.forEach(entity => {
            entity.enabled = visible;
        });
    }
    setDirectionsVisible(visible) {
        this.directionEntities.forEach(entity => {
            entity.enabled = visible;
        });
    }
    clear() {
        if (this.pathEntity) {
            this.pathEntity.destroy();
            this.pathEntity = null;
        }
        this.keyframeEntities.forEach(entity => entity.destroy());
        this.keyframeEntities = [];
        this.directionEntities.forEach(entity => entity.destroy());
        this.directionEntities = [];
    }
    destroy() {
        this.clear();
        this.rootEntity.destroy();
    }
}

// override global pick to pack depth instead of meshInstance id
const pickDepthGlsl = /* glsl */ `
vec4 packFloat(float depth) {
    uvec4 u = (uvec4(floatBitsToUint(depth)) >> uvec4(0u, 8u, 16u, 24u)) & 0xffu;
    return vec4(u) / 255.0;
}
vec4 getPickOutput() {
    return packFloat(gl_FragCoord.z);
}
`;
const gammaChunk = `
vec3 prepareOutputFromGamma(vec3 gammaColor) {
    return gammaColor;
}
`;
const pickDepthWgsl = /* wgsl */ `
    fn packFloat(depth: f32) -> vec4f {
        let u: vec4<u32> = (vec4<u32>(bitcast<u32>(depth)) >> vec4<u32>(0u, 8u, 16u, 24u)) & vec4<u32>(0xffu);
        return vec4f(u) / 255.0;
    }

    fn getPickOutput() -> vec4f {
        return packFloat(pcPosition.z);
    }
`;
const tonemapTable = {
    none: TONEMAP_NONE,
    linear: TONEMAP_LINEAR,
    filmic: TONEMAP_FILMIC,
    hejl: TONEMAP_HEJL,
    aces: TONEMAP_ACES,
    aces2: TONEMAP_ACES2,
    neutral: TONEMAP_NEUTRAL
};
const applyPostEffectSettings = (cameraFrame, settings) => {
    if (settings.sharpness.enabled) {
        cameraFrame.rendering.sharpness = settings.sharpness.amount;
    }
    else {
        cameraFrame.rendering.sharpness = 0;
    }
    const { bloom } = cameraFrame;
    if (settings.bloom.enabled) {
        bloom.intensity = settings.bloom.intensity;
        bloom.blurLevel = settings.bloom.blurLevel;
    }
    else {
        bloom.intensity = 0;
    }
    const { grading } = cameraFrame;
    if (settings.grading.enabled) {
        grading.enabled = true;
        grading.brightness = settings.grading.brightness;
        grading.contrast = settings.grading.contrast;
        grading.saturation = settings.grading.saturation;
        grading.tint = new Color().fromArray(settings.grading.tint);
    }
    else {
        grading.enabled = false;
    }
    const { vignette } = cameraFrame;
    if (settings.vignette.enabled) {
        vignette.intensity = settings.vignette.intensity;
        vignette.inner = settings.vignette.inner;
        vignette.outer = settings.vignette.outer;
        vignette.curvature = settings.vignette.curvature;
    }
    else {
        vignette.intensity = 0;
    }
    const { fringing } = cameraFrame;
    if (settings.fringing.enabled) {
        fringing.intensity = settings.fringing.intensity;
    }
    else {
        fringing.intensity = 0;
    }
};
const anyPostEffectEnabled = (settings) => {
    return (settings.sharpness.enabled && settings.sharpness.amount > 0) ||
        (settings.bloom.enabled && settings.bloom.intensity > 0) ||
        (settings.grading.enabled) ||
        (settings.vignette.enabled && settings.vignette.intensity > 0) ||
        (settings.fringing.enabled && settings.fringing.intensity > 0);
};
const vec = new Vec3();
class Viewer {
    global;
    cameraFrame;
    inputController;
    revealController;
    cameraManager;
    annotations;
    pathVisualizer = null;
    constructor(global, gsplatLoad, skyboxLoad) {
        this.global = global;
        const { app, settings, config, events, state, camera } = global;
        const { graphicsDevice } = app;
        // enable anonymous CORS for image loading in safari
        app.loader.getHandler('texture').imgParser.crossOrigin = 'anonymous';
        // render skybox as plain equirect
        const glsl = ShaderChunks.get(graphicsDevice, 'glsl');
        glsl.set('skyboxPS', glsl.get('skyboxPS').replace('mapRoughnessUv(uv, mipLevel)', 'uv'));
        glsl.set('pickPS', pickDepthGlsl);
        const wgsl = ShaderChunks.get(graphicsDevice, 'wgsl');
        wgsl.set('skyboxPS', wgsl.get('skyboxPS').replace('mapRoughnessUv(uv, uniform.mipLevel)', 'uv'));
        wgsl.set('pickPS', pickDepthWgsl);
        // disable auto render, we'll render only when camera changes
        app.autoRender = false;
        // apply camera animation settings
        camera.camera.aspectRatio = graphicsDevice.width / graphicsDevice.height;
        // configure the camera
        this.configureCamera(settings);
        // reconfigure camera when entering/exiting XR
        app.xr.on('start', () => this.configureCamera(settings));
        app.xr.on('end', () => this.configureCamera(settings));
        // handle horizontal fov on canvas resize
        // const updateHorizontalFov = () => {
        //     camera.camera.horizontalFov = graphicsDevice.width > graphicsDevice.height;
        //     app.renderNextFrame = true;
        // };
        // graphicsDevice.on('resizecanvas', updateHorizontalFov);
        // updateHorizontalFov();
        // handle HQ mode changes
        const updateHqMode = () => {
            graphicsDevice.maxPixelRatio = state.hqMode ? window.devicePixelRatio : 1;
            app.renderNextFrame = true;
        };
        events.on('hqMode:changed', updateHqMode);
        updateHqMode();
        // Construct debug ministats
        if (config.ministats) {
            const options = MiniStats.getDefaultOptions();
            options.cpu.enabled = false;
            options.stats = options.stats.filter((s) => s.name !== 'DrawCalls');
            options.stats.push({
                name: 'VRAM',
                stats: ['vram.tex'],
                decimalPlaces: 1,
                multiplier: 1 / (1024 * 1024),
                unitsName: 'MB',
                watermark: 1024
            });
            // eslint-disable-next-line no-new
            new MiniStats(app, options);
        }
        const prevProj = new Mat4();
        const prevWorld = new Mat4();
        const sceneBound = new BoundingBox();
        // track the camera state and trigger a render when it changes
        app.on('framerender', () => {
            const world = camera.getWorldTransform();
            const proj = camera.camera.projectionMatrix;
            if (!app.renderNextFrame) {
                if (config.ministats ||
                    !nearlyEquals(world.data, prevWorld.data) ||
                    !nearlyEquals(proj.data, prevProj.data)) {
                    app.renderNextFrame = true;
                }
            }
            // suppress rendering till we're ready
            if (!state.readyToRender) {
                app.renderNextFrame = false;
            }
            if (app.renderNextFrame) {
                prevWorld.copy(world);
                prevProj.copy(proj);
            }
        });
        const applyCamera = (camera) => {
            const cameraEntity = global.camera;
            cameraEntity.setPosition(camera.position);
            cameraEntity.setEulerAngles(camera.angles);
            cameraEntity.camera.fov = camera.fov;
            // fit clipping planes to bounding box
            const boundRadius = sceneBound.halfExtents.length();
            // calculate the forward distance between the camera to the bound center
            vec.sub2(sceneBound.center, camera.position);
            const dist = vec.dot(cameraEntity.forward);
            const far = Math.max(dist + boundRadius, 1e-2);
            const near = Math.max(dist - boundRadius, far / (1024 * 16));
            cameraEntity.camera.farClip = far;
            cameraEntity.camera.nearClip = near;
        };
        // handle application update
        app.on('update', (deltaTime) => {
            // in xr mode we leave the camera alone
            if (app.xr.active) {
                return;
            }
            if (this.inputController && this.cameraManager) {
                // update inputs
                this.inputController.update(deltaTime, this.cameraManager.camera.distance);
                // update cameras
                this.cameraManager.update(deltaTime, this.inputController.frame);
                // apply to the camera entity
                applyCamera(this.cameraManager.camera);
            }
        });
        // wait for the model to load
        Promise.all([gsplatLoad, skyboxLoad]).then((results) => {
            const gsplat = results[0].gsplat;
            // get scene bounding box
            const gsplatBbox = gsplat.customAabb;
            if (gsplatBbox) {
                sceneBound.setFromTransformedAabb(gsplatBbox, results[0].getWorldTransform());
            }
            this.annotations = new Annotations(global, this.cameraFrame != null);
            this.inputController = new InputController(global);
            // Set move speed based on scene size
            const sceneSize = sceneBound.halfExtents.length();
            this.inputController.setMoveSpeedFromSceneSize(sceneSize);
            this.revealController = new RevealController(global, sceneBound, results[0]);
            this.cameraManager = new CameraManager(global, sceneBound);
            applyCamera(this.cameraManager.camera);
            // Initialize camera path visualizer if there are animation tracks
            if (settings.animTracks && settings.animTracks.length > 0) {
                this.pathVisualizer = new CameraPathVisualizer(app);
                this.pathVisualizer.visualize(settings.animTracks[0]);
                this.pathVisualizer.setVisible(state.showCameraPath);
                // Listen for state changes
                events.on('showCameraPath:changed', (visible) => {
                    if (this.pathVisualizer) {
                        this.pathVisualizer.setVisible(visible);
                        app.renderNextFrame = true;
                    }
                });
            }
            const { instance } = gsplat;
            if (instance) {
                // kick off gsplat sorting immediately now that camera is in position
                instance.sort(camera);
                // listen for sorting updates to trigger first frame events
                instance.sorter?.on('updated', () => {
                    // request frame render when sorting changes
                    app.renderNextFrame = true;
                    if (!state.readyToRender) {
                        // we're ready to render once the first sort has completed
                        state.readyToRender = true;
                        // wait for the first valid frame to complete rendering
                        app.once('frameend', () => {
                            events.fire('firstFrame');
                            // emit first frame event on window
                            window.firstFrame?.();
                        });
                    }
                });
            }
            else {
                // FIXME: unified doesn't have a sorter, need to add a "ready" event for this case
                // till then screenshots will likely not work correctly.
                state.readyToRender = true;
                events.fire('firstFrame');
                window.firstFrame?.();
            }
        });
    }
    // configure camera based on application mode and post process settings
    configureCamera(settings) {
        const { global } = this;
        const { app, camera } = global;
        const { postEffectSettings } = settings;
        const { background } = settings;
        const enableCameraFrame = !app.xr.active && (anyPostEffectEnabled(postEffectSettings) || settings.highPrecisionRendering);
        if (enableCameraFrame) {
            // create instance
            if (!this.cameraFrame) {
                this.cameraFrame = new CameraFrame(app, camera.camera);
            }
            const { cameraFrame } = this;
            cameraFrame.enabled = true;
            cameraFrame.rendering.toneMapping = tonemapTable[settings.tonemapping];
            cameraFrame.rendering.renderFormats = settings.highPrecisionRendering ? [PIXELFORMAT_RGBA16F, PIXELFORMAT_RGBA32F] : [];
            applyPostEffectSettings(cameraFrame, postEffectSettings);
            cameraFrame.update();
            // force gsplat shader to write gamma-space colors
            ShaderChunks.get(app.graphicsDevice, 'glsl').set('gsplatOutputVS', gammaChunk);
            // ensure the final blit doesn't perform linear->gamma conversion
            RenderTarget.prototype.isColorBufferSrgb = function () {
                return true;
            };
            camera.camera.clearColor = new Color(background.color);
        }
        else {
            // no post effects needed, destroy camera frame if it exists
            if (this.cameraFrame) {
                this.cameraFrame.destroy();
                this.cameraFrame = null;
            }
            if (!app.xr.active) {
                camera.camera.toneMapping = tonemapTable[settings.tonemapping];
                camera.camera.clearColor = new Color(background.color);
            }
        }
    }
    // Camera path visualizer methods
    updateCameraPathVisualizer(options) {
        if (!this.pathVisualizer) {
            this.pathVisualizer = new CameraPathVisualizer(this.global.app, options);
        }
        const { settings } = this.global;
        if (settings.animTracks && settings.animTracks.length > 0) {
            this.pathVisualizer.visualize(settings.animTracks[0]);
        }
    }
    setCameraPathVisible(type, visible) {
        if (!this.pathVisualizer)
            return;
        switch (type) {
            case 'path':
                this.pathVisualizer.setPathVisible(visible);
                break;
            case 'keyframes':
                this.pathVisualizer.setKeyframesVisible(visible);
                break;
            case 'directions':
                this.pathVisualizer.setDirectionsVisible(visible);
                break;
            case 'all':
                this.pathVisualizer.setVisible(visible);
                break;
        }
    }
    destroyCameraPathVisualizer() {
        if (this.pathVisualizer) {
            this.pathVisualizer.destroy();
            this.pathVisualizer = null;
        }
    }
}

// creates an observer proxy object to wrap some target object. fires events when properties change.
const observe = (events, target) => {
    const members = new Set(Object.keys(target));
    return new Proxy(target, {
        set(target, property, value, receiver) {
            // prevent setting symbol properties
            if (typeof property === 'symbol') {
                console.error('Cannot set symbol property on target');
                return false;
            }
            // not allowed to set a new value on target
            if (!members.has(property)) {
                console.error('Cannot set new property on target');
                return false;
            }
            // set and fire event if value changed
            if (target[property] !== value) {
                const prev = target[property];
                target[property] = value;
                events.fire(`${property}:changed`, value, prev);
            }
            return true;
        }
    });
};

const migrateV1 = (settings) => {
    settings.animTracks?.forEach((track) => {
        // some early settings did not have frameRate set on anim tracks
        if (!track.frameRate) {
            const defaultFrameRate = 30;
            track.frameRate = defaultFrameRate;
            const times = track.keyframes.times;
            for (let i = 0; i < times.length; i++) {
                times[i] *= defaultFrameRate;
            }
        }
        // smoothness property added in v1.4.0
        if (!track.hasOwnProperty('smoothness')) {
            track.smoothness = 0;
        }
    });
    return settings;
};
const migrateAnimTrackV2 = (animTrackV1, fov) => {
    return {
        name: animTrackV1.name,
        duration: animTrackV1.duration,
        frameRate: animTrackV1.frameRate,
        loopMode: animTrackV1.loopMode,
        interpolation: animTrackV1.interpolation,
        smoothness: animTrackV1.smoothness,
        keyframes: {
            times: animTrackV1.keyframes.times,
            values: {
                position: animTrackV1.keyframes.values.position,
                target: animTrackV1.keyframes.values.target,
                fov: new Array(animTrackV1.keyframes.times.length).fill(fov)
            }
        }
    };
};
const migrateV2 = (v1) => {
    return {
        version: 2,
        tonemapping: 'none',
        highPrecisionRendering: false,
        background: {
            color: v1.background.color || [0, 0, 0]
        },
        postEffectSettings: {
            sharpness: {
                enabled: false,
                amount: 0
            },
            bloom: {
                enabled: false,
                intensity: 1,
                blurLevel: 2
            },
            grading: {
                enabled: false,
                brightness: 0,
                contrast: 1,
                saturation: 1,
                tint: [1, 1, 1]
            },
            vignette: {
                enabled: false,
                intensity: 0.5,
                inner: 0.3,
                outer: 0.75,
                curvature: 1
            },
            fringing: {
                enabled: false,
                intensity: 0.5
            }
        },
        animTracks: v1.animTracks.map((animTrackV1) => {
            return migrateAnimTrackV2(animTrackV1, v1.camera.fov || 60);
        }),
        cameras: [{
                initial: {
                    position: (v1.camera.position || [0, 0, 5]),
                    target: (v1.camera.target || [0, 0, 0]),
                    fov: v1.camera.fov || 65
                }
            }],
        annotations: [],
        startMode: v1.camera.startAnim === 'animTrack' ? 'animTrack' : 'default',
        hasStartPose: !!(v1.camera.position && v1.camera.target),
        revealEffect: {}
    };
};
// Convert 3x3 rotation matrix to target point
const rotationMatrixToTarget = (position, rotation) => {
    // Extract viewing direction from the third row (camera's Z-axis in world space)
    // Flip X and Y components to match coordinate system
    const forward = new Vec3(-rotation[2][0], -rotation[2][1], rotation[2][2]);
    // Calculate target point at a reasonable distance
    const targetDistance = 3;
    const pos = new Vec3(position[0], position[1], position[2]);
    const target = pos.clone().add(forward.mulScalar(targetDistance));
    return [target.x, target.y, target.z];
};
/**
 * 计算相机水平和垂直 FOV
 * @param fx 水平焦距（像素）
 * @param fy 垂直焦距（像素）
 * @param width 图像宽度（像素）
 * @param height 图像高度（像素）
 * @returns [水平FOV, 垂直FOV]，单位：度
 */
function computeFOV(fx, fy, width, height) {
    const fovX = 2 * Math.atan(width / (2 * fx)) * (180 / Math.PI);
    const fovY = 2 * Math.atan(height / (2 * fy)) * (180 / Math.PI);
    return [fovX, fovY];
}
// Migrate transform format to V2 with animTracks
const migrateTransformToV2 = (transforms) => {
    if (!transforms || transforms.length === 0) {
        throw new Error('Transform array is empty');
    }
    // Use first frame for initial camera pose
    const firstFrame = transforms[0];
    const originalTarget = rotationMatrixToTarget(firstFrame.position, firstFrame.rotation);
    // Flip X and Y axes to match coordinate system
    const initialPosition = [-firstFrame.position[0], -firstFrame.position[1], firstFrame.position[2]];
    const initialTarget = [-originalTarget[0], -originalTarget[1], originalTarget[2]];
    const initialFovs = computeFOV(firstFrame.fx, firstFrame.fy, firstFrame.width, firstFrame.height);
    const initialFov = initialFovs[1]; // vertical fov
    // Build keyframes from all transforms
    const frameRate = firstFrame.fps;
    const times = [];
    const positions = [];
    const targets = [];
    const fovs = [];
    transforms.forEach((frame, index) => {
        times.push(index);
        // Position - flip X and Y axes to match coordinate system
        positions.push(-frame.position[0], -frame.position[1], frame.position[2]);
        // Target (calculated from rotation matrix) - also flip X and Y axes
        const target = rotationMatrixToTarget(frame.position, frame.rotation);
        targets.push(-target[0], -target[1], target[2]);
        // FOV (calculated from focal length)
        const fov_xy = computeFOV(frame.fx, frame.fy, frame.width, frame.height);
        const fov_y = fov_xy[1];
        fovs.push(fov_y);
        if (index === 0) {
            console.log(`=== Frame ${index} ===`);
            console.log('Original Position:', frame.position);
            console.log('Flipped Position:', [-frame.position[0], -frame.position[1], frame.position[2]]);
            console.log('Original Target:', target);
            console.log('Flipped Target:', [-target[0], -target[1], target[2]]);
        }
    });
    // Calculate duration based on number of frames and frame rate
    const duration = (transforms.length - 1) / frameRate;
    return {
        version: 2,
        tonemapping: 'none',
        highPrecisionRendering: false,
        background: {
            color: [0, 0, 0]
        },
        postEffectSettings: {
            sharpness: {
                enabled: false,
                amount: 0
            },
            bloom: {
                enabled: false,
                intensity: 1,
                blurLevel: 2
            },
            grading: {
                enabled: false,
                brightness: 0,
                contrast: 1,
                saturation: 1,
                tint: [1, 1, 1]
            },
            vignette: {
                enabled: false,
                intensity: 0.5,
                inner: 0.3,
                outer: 0.75,
                curvature: 1
            },
            fringing: {
                enabled: false,
                intensity: 0.5
            }
        },
        animTracks: [{
                name: 'Camera Path',
                duration: duration,
                frameRate: frameRate,
                loopMode: 'repeat',
                interpolation: 'spline',
                smoothness: 1, // 增加平滑度：0 = 线性，1 = 最平滑
                keyframes: {
                    times: times,
                    values: {
                        position: positions,
                        target: targets,
                        fov: fovs
                    }
                }
            }],
        cameras: [{
                initial: {
                    position: initialPosition,
                    target: initialTarget,
                    fov: initialFov
                }
            }],
        annotations: [],
        startMode: 'animTrack',
        hasStartPose: true,
        revealEffect: {
            type: 'smooth',
            autoStart: true
        }
    };
};
// import a json object to conform to the latest settings schema. settings is assumed to be one of the well-formed schemas
const importSettings = (settings) => {
    let result;
    // Check if it's a transform array format
    if (Array.isArray(settings) && settings.length > 0 && settings[0].rotation && settings[0].position) {
        // Transform format -> v2
        result = migrateTransformToV2(settings);
    }
    else {
        const version = settings.version;
        if (version === undefined) {
            // v1 -> v2
            result = migrateV2(migrateV1(settings));
        }
        else if (version === 2) {
            // already v2
            result = settings;
        }
        else {
            throw new Error(`Unsupported experience settings version: ${version}`);
        }
    }
    return result;
};

class Tooltip {
    register;
    unregister;
    destroy;
    constructor(dom) {
        const { style } = dom;
        style.display = 'none';
        const targets = new Map();
        let timer = 0;
        this.register = (target, textString, direction = 'bottom') => {
            const activate = () => {
                const rect = target.getBoundingClientRect();
                const midx = Math.floor((rect.left + rect.right) * 0.5);
                const midy = Math.floor((rect.top + rect.bottom) * 0.5);
                switch (direction) {
                    case 'left':
                        style.left = `${rect.left}px`;
                        style.top = `${midy}px`;
                        style.transform = 'translate(calc(-100% - 10px), -50%)';
                        break;
                    case 'right':
                        style.left = `${rect.right}px`;
                        style.top = `${midy}px`;
                        style.transform = 'translate(10px, -50%)';
                        break;
                    case 'top':
                        style.left = `${midx}px`;
                        style.top = `${rect.top}px`;
                        style.transform = 'translate(-50%, calc(-100% - 10px))';
                        break;
                    case 'bottom':
                        style.left = `${midx}px`;
                        style.top = `${rect.bottom}px`;
                        style.transform = 'translate(-50%, 10px)';
                        break;
                }
                dom.textContent = textString;
                style.display = 'inline';
            };
            const startTimer = (fn) => {
                timer = window.setTimeout(() => {
                    fn();
                    timer = -1;
                }, 250);
            };
            const cancelTimer = () => {
                if (timer >= 0) {
                    clearTimeout(timer);
                    timer = -1;
                }
            };
            const enter = () => {
                cancelTimer();
                if (style.display === 'inline') {
                    activate();
                }
                else {
                    startTimer(() => activate());
                }
            };
            const leave = () => {
                cancelTimer();
                if (style.display === 'inline') {
                    startTimer(() => {
                        style.display = 'none';
                    });
                }
            };
            target.addEventListener('pointerenter', enter);
            target.addEventListener('pointerleave', leave);
            targets.set(target, { enter, leave });
        };
        this.unregister = (target) => {
            const value = targets.get(target);
            if (value) {
                target.removeEventListener('pointerenter', value.enter);
                target.removeEventListener('pointerleave', value.leave);
                targets.delete(target);
            }
        };
        this.destroy = () => {
            for (const target of targets.keys()) {
                this.unregister(target);
            }
        };
    }
}

export { Tooltip, Viewer, importSettings as migrateSettings, observe };
//# sourceMappingURL=index.js.map
