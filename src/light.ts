import { Color, Entity } from 'playcanvas';
import type { Global } from './types';

/**
 * 初始化场景光照
 * 创建一个全局光照实体，用于场景照明和 night-mode 效果
 * 
 * @param global - 全局对象，包含 app 等
 * @returns 创建的光照实体
 */
const initLight = (global: Global): Entity => {
    const { app } = global;

    // 检查是否已存在名为 'light' 的实体
    let lightEntity = app.root.findByName('light') as Entity | null;
    
    if (!lightEntity) {
        // 创建新的光照实体
        lightEntity = new Entity('light');
        
        // 设置默认旋转（35, 45, 0）- 与 HTML 中的默认值一致
        lightEntity.setEulerAngles(35, 45, 0);
        
        // 添加光照组件
        lightEntity.addComponent('light', {
            type: 'directional',
            color: new Color(1, 1, 1), // 白色
            intensity: 1.5,
            castShadows: false, // 默认不投射阴影，可根据需要调整
            shadowBias: 0.05,
            normalOffsetBias: 0.05
        });
        
        // 添加到场景根节点
        app.root.addChild(lightEntity);
    } else {
        // 如果实体已存在但缺少 light 组件，则添加
        if (!lightEntity.light) {
            lightEntity.addComponent('light', {
                type: 'directional',
                color: new Color(1, 1, 1),
                intensity: 1.5,
                castShadows: false,
                shadowBias: 0.05,
                normalOffsetBias: 0.05
            });
        }
    }

    // 添加 'light' tag，以便 night-mode 等脚本可以通过 tag 查找
    lightEntity.tags.add('light');

    return lightEntity;
};

export { initLight };
