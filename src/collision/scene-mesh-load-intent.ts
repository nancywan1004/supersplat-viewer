/** 在 settings 尚未写入前，声明本次需要 scene mesh 管线满足的能力。 */
export type SceneMeshLoadIntent = {
    /** 即将或已经需要 URL 碰撞（voxel / GLB mesh collision） */
    wantCollision?: boolean;
    /** 即将或已经需要接影用 scene mesh GLB */
    wantShadow?: boolean;
};
