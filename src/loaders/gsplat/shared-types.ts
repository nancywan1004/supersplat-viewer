/** bootstrap 路径共用的 viewer 侧依赖 */
export type ForceRenderBinding = {
    get: () => boolean;
    set: (value: boolean) => void;
};
