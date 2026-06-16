import {
    Script,
    Entity,
    StandardMaterial,
    BLEND_NONE,
    Vec3,
    type BoundingBox
} from 'playcanvas';

/**
 * 创建与 Demo 的 ShadowMat 完全一致的接影材质：
 * 纯黑（ambient/diffuse/emissive/specular 全 0）、shadowCatcher=true、useLighting=true。
 * 只有这样 PlayCanvas 的 LIT_SHADOW_CATCHER 路径才会输出干净的 R=shadow_term（0/1）。
 */
function createShadowCatcherMaterial(): StandardMaterial {
    const mat = new StandardMaterial();
    mat.shadowCatcher = true;
    mat.ambient.set(0, 0, 0);
    mat.diffuse.set(0, 0, 0);
    mat.emissive.set(0, 0, 0);
    mat.specular.set(0, 0, 0);
    mat.useLighting = true;
    mat.useSkybox = false;
    mat.useFog = false;
    mat.useTonemap = false;
    mat.depthWrite = true;
    mat.depthTest = true;
    mat.blendType = BLEND_NONE;
    mat.opacity = 1;
    mat.update();
    return mat;
}

/**
 * 递归替换实体及其子孙所有 render 的材质为 ShadowMat。
 * castShadows=true 使 mesh 同时作为阴影投射体（自阴影），receiveShadows=true 接收阴影。
 */
function applyShadowMaterialToHierarchy(entity: Entity, material: StandardMaterial) {
    if (entity.render) {
        entity.render.castShadows = true;
        entity.render.receiveShadows = true;
        entity.render.meshInstances?.forEach((mi) => {
            mi.material = material;
        });
    }
    entity.children.forEach((c) => applyShadowMaterialToHierarchy(c as Entity, material));
}

/**
 * Shadow Catcher（接影面）脚本。
 * 只负责维护 geometry 的缩放和 destroy 清理。
 * 材质设置由 initShadowCatcher() 在创建后直接完成（避免 initialize() 时序问题）。
 */
class ShadowCatcher extends Script {
    static scriptName = 'shadowCatcher';

    /** 平面缩放（仅当使用脚本创建的 plane 时生效） */
    scale: Vec3 = new Vec3(1, 1, 1);

    /** 接影几何实体引用 */
    geometry: Entity | undefined;

    debugVisual: boolean = false;

    /** 是否使用外部 GLB mesh（不应用平面缩放） */
    isExternalMesh: boolean = false;

    private _geometryCreated: boolean = false;
    private _catcherMaterial: StandardMaterial | undefined;

    /** 由 initShadowCatcher() 外部调用，在 geometry 已设置好之后执行材质替换 */
    setupMaterial(material: StandardMaterial) {
        this._catcherMaterial = material;
        if (this.geometry) {
            applyShadowMaterialToHierarchy(this.geometry, material);
            console.log('[ShadowCatcher] setupMaterial: applied ShadowMat to geometry hierarchy');
        }
    }

    initialize() {
        // 注意：不在 initialize() 中做材质替换！
        // 因为 PlayCanvas 的 script.create() 会在 script.geometry 赋值之前就调用 initialize()
        // 材质替换由 initShadowCatcher() 调用 setupMaterial() 完成
        this.on('destroy', () => {
            if (this._geometryCreated) {
                this.geometry?.destroy();
            }
            this._catcherMaterial?.destroy();
        });
    }

    update() {
        // GLB mesh 保持原始变换，不施加平面缩放
        if (!this.isExternalMesh) {
            this.geometry?.setLocalScale(this.scale);
        }
    }
}

export type InitShadowCatcherOptions = {
    debugVisual?: boolean;
    parentEntity?: Entity;
    /** 接影几何实体（如 GLB 实例）；若有则不再创建平面 */
    meshEntity?: Entity;
    /** 创建后接影根节点是否 enabled */
    active?: boolean;
};

/**
 * 创建 ShadowCatcher 实体。
 *
 * 关键修复：材质替换在 geometry 设置后通过 setupMaterial() 显式调用，
 * 避免 PlayCanvas script.create() 时 initialize() 先于属性赋值执行的时序问题。
 */
function initShadowCatcher(
    app: { root: Entity },
    sceneBound: BoundingBox,
    options?: InitShadowCatcherOptions
): Entity {
    const center = sceneBound.center;
    const half = sceneBound.halfExtents;
    const sizeX = half.x * 2;
    const sizeZ = half.z * 2;
    const debugVisual = options?.debugVisual ?? false;
    const parentEntity = options?.parentEntity;
    const meshEntity = options?.meshEntity;
    const active = options?.active === true;
    const root = app.root;

    // 创建统一的 ShadowMat
    const shadowMat = createShadowCatcherMaterial();

    const searchRoot = parentEntity ?? root;
    let entity = searchRoot.findByName('shadowCatcher') as Entity | null;

    /** 主 `gsplat` 使用 `setLocalEulerAngles(0,0,180)`；接影挂在其子树下时用局部 Z=-180° 抵消，与 collision / GLB 世界顶点一致 */
    const applyGsplatChildRotationCancel = (catcher: Entity) => {
        if (parentEntity && catcher.parent === parentEntity) {
            catcher.setLocalEulerAngles(0, 0, -180);
        }
    };

    if (entity) {
        const script = entity.script?.get('shadowCatcher') as unknown as ShadowCatcher | undefined;
        // 懒加载 GLB 就绪前可能已用默认平面挂载；收到 mesh 后拆掉平面 catcher 并重建
        if (meshEntity && script && !script.isExternalMesh) {
            entity.destroy();
            entity = null;
        } else {
            if (!meshEntity && parentEntity) {
                entity.setLocalPosition(0, -half.y, 0);
            } else if (!meshEntity) {
                const groundY = center.y - half.y;
                entity.setPosition(center.x, groundY, center.z);
            }
            applyGsplatChildRotationCancel(entity);
            if (script) {
                script.scale.set(sizeX, 1, sizeZ);
                script.debugVisual = debugVisual;
                // 外部 GLB 已挂载时跳过重复材质替换，避免 postEffect:changed / 进编辑等同帧 draw 读到未就绪的 shader impl
                if (!script.isExternalMesh) {
                    script.setupMaterial(shadowMat);
                }
            }
            if (active) {
                entity.enabled = true;
            }
            return entity;
        }
    }

    entity = new Entity('shadowCatcher');

    if (meshEntity) {
        // ─── 使用外部 GLB mesh 作为接影几何 ───
        meshEntity.name = 'ShadowCatcherGeometry';
        entity.addChild(meshEntity);

        if (parentEntity) {
            parentEntity.addChild(entity);
            entity.setLocalPosition(0, 0, 0);
            applyGsplatChildRotationCancel(entity);
        } else {
            root.addChild(entity);
        }

        entity.addComponent('script');
        const script = entity.script.create(ShadowCatcher) as unknown as ShadowCatcher;

        // 关键：先设置 geometry，再调用 setupMaterial()
        script.geometry = meshEntity;
        script.debugVisual = debugVisual;
        // GLB mesh 保持原始变换，不施加平面缩放
        script.isExternalMesh = true;
        script.setupMaterial(shadowMat);
        entity.enabled = active;

        console.log('[initShadowCatcher] Created with GLB mesh (isExternalMesh=true), material applied after geometry set');
        return entity;
    }

    // ─── 创建默认接影平面 ───
    if (parentEntity) {
        parentEntity.addChild(entity);
        entity.setLocalPosition(0, -half.y, 0);
        applyGsplatChildRotationCancel(entity);
    } else {
        const groundY = center.y - half.y;
        entity.setPosition(center.x, groundY, center.z);
        root.addChild(entity);
    }

    const geomEntity = new Entity('ShadowCatcherGeometry');
    geomEntity.addComponent('render', {
        type: 'plane',
        castShadows: false,
        receiveShadows: true,
        material: shadowMat
    });
    entity.addChild(geomEntity);

    entity.addComponent('script');
    const script = entity.script.create(ShadowCatcher) as unknown as ShadowCatcher;
    script.geometry = geomEntity;
    script.debugVisual = debugVisual;
    script.scale.set(sizeX, 1, sizeZ);
    // 平面已经在创建时使用了 ShadowMat，再调一次确保一致
    script.setupMaterial(shadowMat);
    entity.enabled = active;

    console.log('[initShadowCatcher] Created with default plane');
    return entity;
}

export { ShadowCatcher, initShadowCatcher, createShadowCatcherMaterial, applyShadowMaterialToHierarchy };
