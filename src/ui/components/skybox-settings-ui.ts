import type { Global } from '../../types';
import {
    readSkyboxCurrentUrlFromSettings,
    readSkyboxUploadUrlsFromSettings
} from '../../settings-serialize/settings-serialize-helper';

type SkyboxManifestEntry = string | { label?: string; name?: string; file?: string; url?: string };

function deriveSkyboxLabel(value: string): string {
    try {
        const decoded = decodeURIComponent(value);
        const filename = decoded.split('/').pop() || decoded;
        const withoutExt = filename.replace(/\.[^.]+$/, '');
        return withoutExt || decoded;
    } catch {
        return value;
    }
}

function ensureOption(value: string, label: string): HTMLOptionElement {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
}

export function getSkyboxSettingsHTML(): string {
    return `
<div class="skybox-panel-section" data-skybox-settings-root>
    <div class="settingsRow submenuHeader skybox-settings-header expanded" id="skyboxSettingsHeader" role="button" tabindex="0">
        <span class="submenuArrow" id="skyboxSettingsArrow">▶</span>
        <span>天空盒</span>
    </div>
    <div id="skyboxSettingsSubpanel" class="subpanel">
        <div class="settingsRow skybox-settings-hint">
            从内置列表选择当前天空盒，或通过 URL 添加外部资源（写入 uploadUrls 并立即应用）。
        </div>
        <div class="settingsRow">
            <label for="editSkyboxSelect">当前天空盒</label>
            <select id="editSkyboxSelect" class="skybox-settings-select">
                <option value="">无</option>
            </select>
        </div>
        <div class="settingsRow skybox-settings-url-row">
            <label for="editSkyboxUrlInput">天空盒 URL</label>
            <input type="url" id="editSkyboxUrlInput" class="skybox-settings-url-input" placeholder="https://..." autocomplete="off" />
        </div>
        <div class="settingsRow">
            <button type="button" id="editSkyboxAddBtn" class="skybox-settings-add-btn">添加并应用</button>
        </div>
    </div>
</div>`.trim();
}

/**
 * 编辑模式右侧「天空盒」模块：内置列表 + uploadUrls + 手动输入 URL（skyboxAdd）。
 */
export function bindSkyboxSettings(root: ParentNode | null, global: Global): () => void {
    if (!root) return () => {};

    const { events, config } = global;
    const select = root.querySelector<HTMLSelectElement>('#editSkyboxSelect');
    const urlInput = root.querySelector<HTMLInputElement>('#editSkyboxUrlInput');
    const addBtn = root.querySelector<HTMLButtonElement>('#editSkyboxAddBtn');
    if (!select) return () => {};

    const populateSkyboxes = async () => {
        try {
            const response = await fetch('/assets/skyboxes/index.json', {
                cache: 'force-cache'
            });
            if (!response.ok) {
                throw new Error(`Failed to load skybox list: ${response.status}`);
            }

            const manifest = await response.json() as SkyboxManifestEntry[];
            const normalized = manifest
                .map((entry) => {
                    if (typeof entry === 'string') {
                        return {
                            label: deriveSkyboxLabel(entry),
                            value: `/assets/skyboxes/${entry}`
                        };
                    }
                    const file = entry.file ?? '';
                    const rawValue = entry.url ?? (file ? `/assets/skyboxes/${file}` : '');
                    if (!rawValue) return null;
                    return {
                        label: entry.label ?? entry.name ?? deriveSkyboxLabel(file || rawValue),
                        value: rawValue
                    };
                })
                .filter((item): item is { label: string; value: string } => !!item?.value);

            const uploadSkyboxUrls = readSkyboxUploadUrlsFromSettings(global.settings);
            const current = readSkyboxCurrentUrlFromSettings(global.settings) ?? config.skyboxUrl ?? '';

            select.innerHTML = '';
            select.appendChild(ensureOption('', '无'));
            normalized.forEach(({ label, value }) => {
                select.appendChild(ensureOption(value, label));
            });
            uploadSkyboxUrls.forEach((value) => {
                if (!normalized.some((item) => item.value === value)) {
                    select.appendChild(ensureOption(value, deriveSkyboxLabel(value)));
                }
            });
            if (current && !normalized.some(({ value }) => value === current)) {
                if (!uploadSkyboxUrls.includes(current)) {
                    select.appendChild(ensureOption(current, deriveSkyboxLabel(current)));
                }
            }
            select.value = current || '';
        } catch (err) {
            console.warn('[SuperSplat] 无法加载天空盒列表：', err);
        }
    };

    const onSelectChange = () => {
        events.fire('skyboxSet', select.value || null);
    };

    const onAddClick = () => {
        const trimmed = urlInput?.value.trim() ?? '';
        if (!trimmed) {
            console.warn('[SuperSplat] 请输入有效的天空盒 URL');
            urlInput?.focus();
            return;
        }
        events.fire('skyboxAdd', trimmed);
        if (urlInput) urlInput.value = '';
    };

    const onUrlKeydown = (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            onAddClick();
        }
    };

    const onSelectionSynced = (value?: string | null) => {
        select.value = value ?? '';
    };

    select.addEventListener('change', onSelectChange);
    addBtn?.addEventListener('click', onAddClick);
    urlInput?.addEventListener('keydown', onUrlKeydown);
    events.on('skyboxSelectionSynced', onSelectionSynced);
    events.on('skyboxListChanged', populateSkyboxes);

    void populateSkyboxes();

    return () => {
        select.removeEventListener('change', onSelectChange);
        addBtn?.removeEventListener('click', onAddClick);
        urlInput?.removeEventListener('keydown', onUrlKeydown);
        events.off('skyboxSelectionSynced', onSelectionSynced);
        events.off('skyboxListChanged', populateSkyboxes);
    };
}
