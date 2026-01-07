# 相机约束系统（简化版）

基于单一Bounding Sphere的相机移动限制系统。

## 设计原则

1. **简单统一**：Orbit和Fly模式使用相同的sphere约束
2. **无跳变**：模式切换时保持相机位置不变，确保平滑过渡
3. **可视化**：显示约束sphere的范围

## 实现

### 核心组件

- `BoundingSphere`: 简单的sphere数据结构
- `SphereConstraint`: 约束封装，提供clampPoint等方法
- `OrbitController`: 集成约束，限制相机位置在sphere内
- `FlyController`: 集成约束，限制相机位置在sphere内

### 约束应用

1. **Orbit模式**：在update中限制相机位置
2. **Fly模式**：在移动预测后限制相机位置
3. **模式切换**：由于使用相同约束，切换时无跳变

### 可视化

在CameraManager中自动创建绿色半透明sphere，显示约束范围。

## 使用

系统自动初始化，无需手动配置。约束从场景的BoundingBox创建，收缩系数为0.7（排除离群点）。

