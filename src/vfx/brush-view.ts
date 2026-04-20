/**
 * Bloom 笔刷 / 局部亮灯区域的**只读视图**（不落 settingsJson，由 editor + bloom 片段即时算出）。
 *
 * ## 状态 × 语义（实现其它文件时请与此表一致）
 *
 * | 字段 | 含义 |
 * |------|------|
 * | `tool` | `paint`：正在画；`erase`：橡皮；`off`：非绘制笔划（笔刷会话仍可能 `brush===true`） |
 * | `kind` | 当前 `activeLocalLightRegionId`：`draft` = 草稿 `draft-*`；`saved` = 非草稿字符串；`none` = 未选/空 |
 * | `nRegions` | `localLightRegions.length` |
 * | `brush` | `bloomEditorSession.bloomBrush` |
 * | `draftOnly` | **唯一派生**：`brush` 且激活为草稿时，体积/mask 只走当前草稿工作区，不叠已提交区 |
 *
 * 不包含 reveal、点数 `wsLen`；点数在 `bloom.ts` 就地读取。
 */

/** 笔划工具（来自 `isDrawing` / `isErasing`） */
export type BrushTool = 'off' | 'paint' | 'erase';

/** 当前激活区域 id 的类别（与 `activeLocalLightRegionId` 字符串约定对齐） */
export type BrushKind = 'none' | 'draft' | 'saved';

export type BrushView = {
    tool: BrushTool;
    kind: BrushKind;
    /** `postEffectSettings.bloom.localLightRegions.length` */
    nRegions: number;
    /** `postEffectSettings.bloomEditorSession.bloomBrush` */
    brush: boolean;
    /**
     * 与历史 `isSoloDraftRegionVolumePreview` 一致：笔刷会话且激活 id 为 `draft-*` 时，
     * 完成「转正」前体积/多区域 mask 只反映当前草稿。
     */
    draftOnly: boolean;
};

export type ComputeBrushViewInput = {
    /** `bloomEditorSession.bloomBrush` */
    brush: boolean;
    /** `bloomEditorSession.activeLocalLightRegionId` */
    activeId: string | null | undefined;
    /** `bloom.localLightRegions.length` */
    nRegions: number;
    /** `BloomController` 指针态：是否正在按下绘制 */
    drawing: boolean;
    /** `BloomController` 指针态：是否橡皮 */
    erasing: boolean;
};

/**
 * 由 `activeLocalLightRegionId` 解析 `kind`（不写回 JSON）。
 * - `draft-*` → `draft`
 * - 其它非空字符串 → `saved`
 * - 空 / null → `none`
 */
export function parseKind(activeId: string | null | undefined): BrushKind {
    if (activeId == null) return 'none';
    const id = String(activeId).trim();
    if (!id) return 'none';
    if (id.startsWith('draft-')) return 'draft';
    return 'saved';
}

function toolFromPointer(drawing: boolean, erasing: boolean): BrushTool {
    if (erasing) return 'erase';
    if (drawing) return 'paint';
    return 'off';
}

/**
 * 聚合笔刷会话、激活区、区域数、指针工具态；`draftOnly` 只在此计算一次。
 */
export function computeBrushView(input: ComputeBrushViewInput): BrushView {
    const { brush, activeId, nRegions, drawing, erasing } = input;
    const kind = parseKind(activeId);
    const draftOnly = brush && kind === 'draft';
    return {
        tool: toolFromPointer(drawing, erasing),
        kind,
        nRegions: Math.max(0, nRegions | 0),
        brush: !!brush,
        draftOnly
    };
}
