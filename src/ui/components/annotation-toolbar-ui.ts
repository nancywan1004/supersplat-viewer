/**
 * 标注工具栏 UI 组件
 * 负责右侧工具栏的显示、标注编辑表单和标注列表
 */

import type { AnnotationFormData, AnnotationData } from '../../annotation-toolbar/types';
import { annotationMediaUrl } from '../../annotation-toolbar/media-fields';
import { Annotation } from '../../annotation';

type AnnotationMediaType = 'none' | 'image' | 'video';

const EYE_SVG =
    '<svg class="icon-eye" viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>';
const EYE_OFF_SVG =
    '<svg class="icon-eye-off" viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/></svg>';

export class AnnotationToolbarUI {
    private container: HTMLElement | null = null;
    private editForm: HTMLElement | null = null;
    private annotationList: HTMLElement | null = null;
    private createButton: HTMLButtonElement | null = null;
    private confirmButton: HTMLButtonElement | null = null;
    private placeButton: HTMLButtonElement | null = null;
    private cancelButton: HTMLButtonElement | null = null;
    private titleInput: HTMLInputElement | null = null;
    private textInput: HTMLTextAreaElement | null = null;
    private imageInput: HTMLInputElement | null = null;
    private imagePreview: HTMLImageElement | null = null;
    private imageMediaGroup: HTMLElement | null = null;
    private videoMediaGroup: HTMLElement | null = null;
    private videoUrlInput: HTMLInputElement | null = null;
    private videoFileInput: HTMLInputElement | null = null;
    private pendingImageFile: File | null = null;
    private pendingVideoFile: File | null = null;
    private currentImageUrl: string | undefined;
    private currentVideoUrl: string | undefined;
    private previewObjectUrl: string | null = null;
    private mediaTypeRadios: { none: HTMLInputElement; image: HTMLInputElement; video: HTMLInputElement } | null = null;
    private showTitleCheckbox: HTMLInputElement | null = null;
    private titleCharCount: HTMLElement | null = null;
    private textCharCount: HTMLElement | null = null;
    private placementHint: HTMLElement | null = null;

    // 回调函数
    private createButtonCallback: (() => void) | null = null;
    private confirmButtonCallback: ((data: AnnotationFormData) => void) | null = null;
    private placeButtonCallback: (() => void) | null = null;
    private cancelButtonCallback: (() => void) | null = null;
    private deleteButtonCallback: ((id: string) => void) | null = null;
    private annotationSelectCallback: ((id: string) => void) | null = null;
    private annotationEditCallback: ((id: string, isUpdate: boolean) => void) | null = null;
    private visibilityToggleCallback: ((id: string, visible: boolean) => void) | null = null;
    private inputChangeCallback: ((data: Partial<AnnotationFormData>) => void) | null = null;

    /** 当前是否为编辑已有标注模式（非占位标注） */
    private isEditMode = false;
    /** 编辑模式下的标注 ID */
    private editingAnnotationId: string | null = null;

    /**
     * @param parentEl - 可选的挂载父元素，不传则挂载到 document.body
     */
    constructor(parentEl?: HTMLElement) {
        this.createDOM(parentEl);
        this.bindEvents();
    }

    /**
     * 创建工具栏 DOM 结构
     * @param parentEl - 可选的挂载父元素
     */
    private createDOM(parentEl?: HTMLElement): void {
        // 创建主容器
        this.container = document.createElement('div');
        this.container.id = 'annotationToolbar';
        this.container.className = 'annotation-toolbar hidden';

        // 创建工具栏内容容器（可滚动）
        const scrollContainer = document.createElement('div');
        scrollContainer.className = 'annotation-toolbar-scroll';

        // 创建"新建场景标注"按钮
        this.createButton = document.createElement('button');
        this.createButton.className = 'annotation-create-btn';
        this.createButton.textContent = '+ 新建场景标注';
        scrollContainer.appendChild(this.createButton);

        // 放置模式提示（点击新增后显示，放置后隐藏）
        this.placementHint = document.createElement('div');
        this.placementHint.className = 'annotation-placement-hint hidden';
        this.placementHint.textContent = '请先在场景中选择放置位置';
        scrollContainer.appendChild(this.placementHint);

        // 创建编辑表单
        this.editForm = this.createEditForm();
        scrollContainer.appendChild(this.editForm);

        // 创建标注列表
        this.annotationList = this.createAnnotationList();
        scrollContainer.appendChild(this.annotationList);

        this.container.appendChild(scrollContainer);

        // 挂载到 DOM
        (parentEl ?? document.body).appendChild(this.container);
    }

    /**
     * 创建标注编辑表单
     */
    private createEditForm(): HTMLElement {
        const form = document.createElement('div');
        form.className = 'annotation-edit-form hidden';

        // 表单标题
        const formTitle = document.createElement('div');
        formTitle.className = 'annotation-form-title';
        formTitle.textContent = '编辑标注';
        form.appendChild(formTitle);

        // 标题输入框
        const titleGroup = document.createElement('div');
        titleGroup.className = 'annotation-form-group';
        
        const titleLabel = document.createElement('label');
        titleLabel.textContent = '标题';
        titleLabel.className = 'annotation-form-label';
        titleGroup.appendChild(titleLabel);

        this.titleInput = document.createElement('input');
        this.titleInput.type = 'text';
        this.titleInput.className = 'annotation-form-input';
        this.titleInput.placeholder = '输入标题（最多20字符）';
        this.titleInput.maxLength = 20;
        titleGroup.appendChild(this.titleInput);

        this.titleCharCount = document.createElement('div');
        this.titleCharCount.className = 'annotation-char-count';
        this.titleCharCount.textContent = '0/20';
        titleGroup.appendChild(this.titleCharCount);

        form.appendChild(titleGroup);

        // 正文输入框
        const textGroup = document.createElement('div');
        textGroup.className = 'annotation-form-group';
        
        const textLabel = document.createElement('label');
        textLabel.textContent = '正文';
        textLabel.className = 'annotation-form-label';
        textGroup.appendChild(textLabel);

        this.textInput = document.createElement('textarea');
        this.textInput.className = 'annotation-form-textarea';
        this.textInput.placeholder = '输入正文（最多50字符）';
        this.textInput.maxLength = 50;
        this.textInput.rows = 3;
        textGroup.appendChild(this.textInput);

        this.textCharCount = document.createElement('div');
        this.textCharCount.className = 'annotation-char-count';
        this.textCharCount.textContent = '0/50';
        textGroup.appendChild(this.textCharCount);

        form.appendChild(textGroup);

        const mediaGroup = document.createElement('div');
        mediaGroup.className = 'annotation-form-group';

        const mediaLabel = document.createElement('label');
        mediaLabel.textContent = '媒体';
        mediaLabel.className = 'annotation-form-label';
        mediaGroup.appendChild(mediaLabel);

        const mediaTypeRow = document.createElement('div');
        mediaTypeRow.className = 'annotation-media-type-row';

        const mkMediaRadio = (value: AnnotationMediaType, label: string) => {
            const wrap = document.createElement('label');
            wrap.className = 'annotation-media-type-option';
            const input = document.createElement('input');
            input.type = 'radio';
            input.name = 'annotationMediaType';
            input.value = value;
            if (value === 'none') input.checked = true;
            wrap.appendChild(input);
            wrap.appendChild(document.createTextNode(label));
            mediaTypeRow.appendChild(wrap);
            return input;
        };

        this.mediaTypeRadios = {
            none: mkMediaRadio('none', '无'),
            image: mkMediaRadio('image', '图片'),
            video: mkMediaRadio('video', '视频')
        };
        mediaGroup.appendChild(mediaTypeRow);

        this.imageMediaGroup = document.createElement('div');
        this.imageMediaGroup.className = 'annotation-media-panel hidden';
        this.imageInput = document.createElement('input');
        this.imageInput.type = 'file';
        this.imageInput.className = 'annotation-form-file-input';
        this.imageInput.accept = 'image/*';
        this.imageMediaGroup.appendChild(this.imageInput);
        this.imagePreview = document.createElement('img');
        this.imagePreview.className = 'annotation-image-preview hidden';
        this.imageMediaGroup.appendChild(this.imagePreview);
        mediaGroup.appendChild(this.imageMediaGroup);

        this.videoMediaGroup = document.createElement('div');
        this.videoMediaGroup.className = 'annotation-media-panel hidden';
        this.videoUrlInput = document.createElement('input');
        this.videoUrlInput.type = 'url';
        this.videoUrlInput.className = 'annotation-form-input';
        this.videoUrlInput.placeholder = '视频 URL（https://...）';
        this.videoMediaGroup.appendChild(this.videoUrlInput);
        this.videoFileInput = document.createElement('input');
        this.videoFileInput.type = 'file';
        this.videoFileInput.className = 'annotation-form-file-input';
        this.videoFileInput.accept = 'video/*';
        this.videoMediaGroup.appendChild(this.videoFileInput);
        mediaGroup.appendChild(this.videoMediaGroup);

        form.appendChild(mediaGroup);

        const checkboxGroup = document.createElement('div');
        checkboxGroup.className = 'annotation-form-group annotation-checkbox-group';

        this.showTitleCheckbox = document.createElement('input');
        this.showTitleCheckbox.type = 'checkbox';
        this.showTitleCheckbox.id = 'annotationShowTitle';
        this.showTitleCheckbox.className = 'annotation-form-checkbox';
        checkboxGroup.appendChild(this.showTitleCheckbox);

        const checkboxLabel = document.createElement('label');
        checkboxLabel.htmlFor = 'annotationShowTitle';
        checkboxLabel.textContent = '收起时显示标题';
        checkboxLabel.className = 'annotation-checkbox-label';
        checkboxGroup.appendChild(checkboxLabel);

        form.appendChild(checkboxGroup);

        const buttonGroup = document.createElement('div');
        buttonGroup.className = 'annotation-form-buttons';

        this.cancelButton = document.createElement('button');
        this.cancelButton.className = 'annotation-form-btn annotation-cancel-btn';
        this.cancelButton.textContent = '取消';
        buttonGroup.appendChild(this.cancelButton);

        this.confirmButton = document.createElement('button');
        this.confirmButton.className = 'annotation-form-btn annotation-confirm-btn';
        this.confirmButton.textContent = '更新';
        buttonGroup.appendChild(this.confirmButton);

        this.placeButton = document.createElement('button');
        this.placeButton.className = 'annotation-form-btn annotation-place-btn';
        this.placeButton.textContent = '去放置';
        this.placeButton.disabled = true;
        buttonGroup.appendChild(this.placeButton);

        form.appendChild(buttonGroup);

        return form;
    }

    /**
     * 创建标注列表
     */
    private createAnnotationList(): HTMLElement {
        const list = document.createElement('div');
        list.className = 'annotation-list';

        const listTitle = document.createElement('div');
        listTitle.className = 'annotation-list-title';
        listTitle.textContent = '标注列表';
        list.appendChild(listTitle);

        const listContainer = document.createElement('div');
        listContainer.className = 'annotation-list-container';
        list.appendChild(listContainer);

        return list;
    }

    private getSelectedMediaType(): AnnotationMediaType {
        if (this.mediaTypeRadios?.video.checked) {
            return 'video';
        }
        if (this.mediaTypeRadios?.image.checked) {
            return 'image';
        }
        return 'none';
    }

    private revokePreviewUrl(): void {
        if (this.previewObjectUrl) {
            URL.revokeObjectURL(this.previewObjectUrl);
            this.previewObjectUrl = null;
        }
    }

    private updateMediaPanelsVisibility(): void {
        const type = this.getSelectedMediaType();
        this.imageMediaGroup?.classList.toggle('hidden', type !== 'image');
        this.videoMediaGroup?.classList.toggle('hidden', type !== 'video');
        if (type !== 'image') {
            this.pendingImageFile = null;
            this.revokePreviewUrl();
            if (this.imagePreview) {
                this.imagePreview.src = '';
                this.imagePreview.classList.add('hidden');
            }
            if (this.imageInput) {
                this.imageInput.value = '';
            }
        }
        if (type !== 'video') {
            this.pendingVideoFile = null;
            if (this.videoUrlInput) this.videoUrlInput.value = '';
            if (this.videoFileInput) this.videoFileInput.value = '';
        }
    }

    private setMediaType(type: AnnotationMediaType): void {
        if (!this.mediaTypeRadios) {
            return;
        }
        this.mediaTypeRadios[type].checked = true;
        this.updateMediaPanelsVisibility();
    }

    /**
     * 绑定事件
     */
    private bindEvents(): void {
        // 创建按钮点击
        this.createButton?.addEventListener('click', () => {
            this.createButtonCallback?.();
        });

        // 确认/更新按钮点击（仅编辑已有标注时可见）
        this.confirmButton?.addEventListener('click', () => {
            if (this.isEditMode && this.editingAnnotationId) {
                this.annotationEditCallback?.(this.editingAnnotationId, true);
            } else {
                this.confirmButtonCallback?.(this.getFormData());
            }
        });

        // 去放置 / 确定并放置 按钮点击（仅新建标注时可见）
        this.placeButton?.addEventListener('click', () => {
            this.placeButtonCallback?.();
        });

        // 取消按钮点击
        this.cancelButton?.addEventListener('click', () => {
            this.cancelButtonCallback?.();
        });

        // 标题输入实时更新
        this.titleInput?.addEventListener('input', () => {
            this.updateCharCount();
            this.notifyInputChange();
        });

        // 正文输入实时更新
        this.textInput?.addEventListener('input', () => {
            this.updateCharCount();
            this.notifyInputChange();
        });

        this.imageInput?.addEventListener('change', (e) => {
            const target = e.target as HTMLInputElement;
            const file = target.files?.[0];
            if (file) {
                this.handleImageUpload(file);
            }
        });

        Object.values(this.mediaTypeRadios ?? {}).forEach((radio) => {
            radio.addEventListener('change', () => {
                this.updateMediaPanelsVisibility();
                this.notifyInputChange();
            });
        });

        this.videoUrlInput?.addEventListener('input', () => {
            if (this.videoUrlInput?.value.trim()) {
                this.pendingVideoFile = null;
                if (this.videoFileInput) this.videoFileInput.value = '';
            }
            this.notifyInputChange();
        });

        this.videoFileInput?.addEventListener('change', (e) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (!file) return;
            this.pendingVideoFile = file;
            this.currentVideoUrl = undefined;
            if (this.videoUrlInput) this.videoUrlInput.value = '';
            this.notifyInputChange();
        });

        // 复选框变化
        this.showTitleCheckbox?.addEventListener('change', () => {
            this.notifyInputChange();
        });
    }

    /**
     * 处理图片上传
     */
    private handleImageUpload(file: File): void {
        if (!file.type.startsWith('image/')) {
            alert('请选择有效的图片文件');
            return;
        }
        const maxSize = 5 * 1024 * 1024;
        if (file.size > maxSize) {
            alert('图片文件大小不能超过 5MB');
            return;
        }
        this.setMediaType('image');
        this.pendingImageFile = file;
        this.currentImageUrl = undefined;
        this.revokePreviewUrl();
        this.previewObjectUrl = URL.createObjectURL(file);
        if (this.imagePreview) {
            this.imagePreview.src = this.previewObjectUrl;
            this.imagePreview.classList.remove('hidden');
        }
        this.notifyInputChange();
    }

    /**
     * 更新字符计数显示
     */
    private updateCharCount(): void {
        if (this.titleInput && this.titleCharCount) {
            const length = this.titleInput.value.length;
            this.titleCharCount.textContent = `${length}/20`;
        }
        if (this.textInput && this.textCharCount) {
            const length = this.textInput.value.length;
            this.textCharCount.textContent = `${length}/50`;
        }
    }

    /**
     * 通知输入变化
     */
    private notifyInputChange(): void {
        const data = this.getFormData();

        // 新建模式下，根据是否填写标题和正文启用「去放置」按钮
        if (!this.isEditMode && this.placeButton) {
            const canPlace = !!data.title && !!data.text;
            this.placeButton.disabled = !canPlace;
        }

        if (this.inputChangeCallback) {
            this.inputChangeCallback(data);
        }
    }

    /**
     * 获取表单数据（公开供外部读取当前表单内容）
     */
    getFormData(): AnnotationFormData {
        const base = {
            title: this.titleInput?.value || '',
            text: this.textInput?.value || '',
            showTitleWhenCollapsed: this.showTitleCheckbox?.checked || false
        };
        const mediaType = this.getSelectedMediaType();
        if (mediaType === 'image') {
            return {
                ...base,
                image: this.pendingImageFile ?? this.currentImageUrl
            };
        }
        if (mediaType === 'video') {
            const url = this.videoUrlInput?.value.trim() || this.currentVideoUrl || '';
            return {
                ...base,
                video: this.pendingVideoFile ?? (url || undefined)
            };
        }
        return { ...base };
    }

    /**
     * 显示工具栏
     */
    show(): void {
        this.container?.classList.remove('hidden');
    }

    /**
     * 隐藏工具栏
     */
    hide(): void {
        this.container?.classList.add('hidden');
    }

    /**
     * 显示编辑表单
     * @param annotation - 标注数据，不传则清空表单（用于新建）
     * @param isEditMode - 是否为编辑已有标注模式（true 时确认按钮显示「更新」）
     */
    showEditForm(annotation?: AnnotationData, isEditMode = false): void {
        this.isEditMode = isEditMode;
        this.editingAnnotationId = isEditMode && annotation ? annotation.id : null;
        if (annotation) {
            // 填充现有标注数据
            if (this.titleInput) this.titleInput.value = annotation.title || '';
            if (this.textInput) this.textInput.value = annotation.text || '';
            if (this.showTitleCheckbox) this.showTitleCheckbox.checked = annotation.showTitleWhenCollapsed || false;
            const videoUrl = annotationMediaUrl(annotation.video);
            const imageUrl = annotationMediaUrl(annotation.image);
            if (videoUrl) {
                this.setMediaType('video');
                this.pendingVideoFile = null;
                this.currentVideoUrl = videoUrl;
                this.currentImageUrl = undefined;
                if (this.videoUrlInput) this.videoUrlInput.value = videoUrl;
            } else if (imageUrl) {
                this.setMediaType('image');
                this.pendingImageFile = null;
                this.currentImageUrl = imageUrl;
                this.currentVideoUrl = undefined;
                this.revokePreviewUrl();
                if (this.imagePreview) {
                    this.imagePreview.src = Annotation.resolveMediaUrl(imageUrl) || imageUrl;
                    this.imagePreview.classList.remove('hidden');
                }
            } else {
                this.setMediaType('none');
                this.currentImageUrl = undefined;
                this.currentVideoUrl = undefined;
            }
            if (this.imageInput) this.imageInput.value = '';
            if (this.videoFileInput) this.videoFileInput.value = '';
        } else {
            if (this.titleInput) this.titleInput.value = '';
            if (this.textInput) this.textInput.value = '';
            if (this.showTitleCheckbox) this.showTitleCheckbox.checked = false;
            this.setMediaType('none');
            this.pendingImageFile = null;
            this.pendingVideoFile = null;
            this.currentImageUrl = undefined;
            this.currentVideoUrl = undefined;
            this.revokePreviewUrl();
            if (this.imagePreview) {
                this.imagePreview.classList.add('hidden');
                this.imagePreview.src = '';
            }
            if (this.imageInput) this.imageInput.value = '';
            if (this.videoUrlInput) this.videoUrlInput.value = '';
            if (this.videoFileInput) this.videoFileInput.value = '';
        }
        this.updateCharCount();

        // 编辑已有标注：显示「更新」按钮，隐藏「去放置」按钮
        if (isEditMode) {
            if (this.confirmButton) {
                this.confirmButton.style.display = '';
                this.confirmButton.textContent = '更新';
            }
            if (this.placeButton) {
                this.placeButton.style.display = 'none';
            }
        } else {
            // 新建标注：隐藏确认按钮，只显示「去放置 / 确定并放置」按钮
            if (this.confirmButton) {
                this.confirmButton.style.display = 'none';
            }
            if (this.placeButton) {
                this.placeButton.style.display = '';
                this.placeButton.textContent = '去放置';
                // 是否可点击由 notifyInputChange / getFormData 控制
                const canPlace = !!this.titleInput?.value && !!this.textInput?.value;
                this.placeButton.disabled = !canPlace;
            }
        }

        this.editForm?.classList.remove('hidden');
    }

    /**
     * 隐藏编辑表单
     */
    hideEditForm(): void {
        this.editForm?.classList.add('hidden');
        this.isEditMode = false;
        this.editingAnnotationId = null;
    }

    /**
     * 显示/隐藏放置模式提示（「请先在场景中选择放置位置」）
     */
    setPlacementHintVisible(visible: boolean): void {
        if (this.placementHint) {
            this.placementHint.classList.toggle('hidden', !visible);
        }
    }

    /** 获取当前正在编辑的标注 ID */
    getEditingAnnotationId(): string | null {
        return this.editingAnnotationId;
    }

    /**
     * 更新标注列表
     * @param annotations - 标注数据列表
     * @param editingId - 当前正在编辑的标注 ID（其编辑按钮显示为「更新」）
     * @param selectedId - 当前选中的标注 ID（仅此项高亮，与场景选中状态一致）
     */
    updateAnnotationList(annotations: AnnotationData[], editingId?: string | null, selectedId?: string | null): void {
        const listContainer = this.annotationList?.querySelector('.annotation-list-container');
        if (!listContainer) return;

        // 清空现有列表
        listContainer.innerHTML = '';

        if (annotations.length === 0) {
            const emptyMessage = document.createElement('div');
            emptyMessage.className = 'annotation-list-empty';
            emptyMessage.textContent = '暂无标注';
            listContainer.appendChild(emptyMessage);
            return;
        }

        // 渲染标注列表项（高亮由 selectedId 驱动，与场景选中一致）
        annotations.forEach((annotation) => {
            const item = document.createElement('div');
            item.className = 'annotation-list-item' + (selectedId === annotation.id ? ' selected' : '');
            item.dataset.annotationId = annotation.id;

            const itemContent = document.createElement('div');
            itemContent.className = 'annotation-list-item-content';
            
            const itemTitle = document.createElement('div');
            itemTitle.className = 'annotation-list-item-title';
            itemTitle.textContent = annotation.title || '未命名标注';
            itemContent.appendChild(itemTitle);

            const itemText = document.createElement('div');
            itemText.className = 'annotation-list-item-text';
            itemText.textContent = annotation.text || '';
            itemContent.appendChild(itemText);

            item.appendChild(itemContent);

            const isVisible = annotation.visible !== false;
            const eyeBtn = document.createElement('button');
            eyeBtn.type = 'button';
            eyeBtn.className = 'annotation-list-item-visibility' + (isVisible ? '' : ' hidden');
            eyeBtn.innerHTML = EYE_SVG;
            eyeBtn.title = '隐藏标注';
            eyeBtn.setAttribute('aria-label', '隐藏标注');
            const eyeOffBtn = document.createElement('button');
            eyeOffBtn.type = 'button';
            eyeOffBtn.className = 'annotation-list-item-visibility' + (isVisible ? ' hidden' : '');
            eyeOffBtn.innerHTML = EYE_OFF_SVG;
            eyeOffBtn.title = '显示标注';
            eyeOffBtn.setAttribute('aria-label', '显示标注');

            const toggleVisibility = (e: Event) => {
                e.stopPropagation();
                this.visibilityToggleCallback?.(annotation.id, !isVisible);
            };
            eyeBtn.addEventListener('click', toggleVisibility);
            eyeOffBtn.addEventListener('click', toggleVisibility);
            item.appendChild(eyeBtn);
            item.appendChild(eyeOffBtn);

            // 编辑/更新按钮（编辑中时显示「更新」）
            const editBtn = document.createElement('button');
            editBtn.className = 'annotation-list-item-edit';
            editBtn.textContent = editingId === annotation.id ? '更新' : '编辑';
            editBtn.title = editingId === annotation.id ? '保存修改' : '编辑标注';
            editBtn.dataset.annotationId = annotation.id;
            item.appendChild(editBtn);

            // 删除按钮
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'annotation-list-item-delete';
            deleteBtn.textContent = '×';
            deleteBtn.title = '删除标注';
            item.appendChild(deleteBtn);

            // 点击列表项选择标注（选中状态由 updateAnnotationList 的 selectedId 驱动，选中后会触发 updateList 重绘）
            itemContent.addEventListener('click', () => {
                this.annotationSelectCallback?.(annotation.id);
            });

            // 点击编辑/更新按钮：编辑时显示表单+Gizmo，更新时保存
            editBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const isUpdate = editingId === annotation.id;
                this.annotationEditCallback?.(annotation.id, isUpdate);
            });

            // 点击删除按钮
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.deleteButtonCallback?.(annotation.id);
            });

            listContainer.appendChild(item);
        });
    }

    /**
     * 注册创建按钮回调
     */
    onCreateButtonClick(callback: () => void): void {
        this.createButtonCallback = callback;
    }

    /**
     * 注册确认按钮回调
     */
    onConfirmButtonClick(callback: (data: AnnotationFormData) => void): void {
        this.confirmButtonCallback = callback;
    }

    /**
     * 注册「去放置 / 确定并放置」按钮回调（仅新建标注场景）
     */
    onPlaceButtonClick(callback: () => void): void {
        this.placeButtonCallback = callback;
    }

    /**
     * 更新「去放置 / 确定并放置」按钮文案和可用状态
     */
    setPlaceButton(label: string, enabled: boolean): void {
        if (!this.placeButton) return;
        this.placeButton.textContent = label;
        this.placeButton.disabled = !enabled;
    }

    /**
     * 注册取消按钮回调
     */
    onCancelButtonClick(callback: () => void): void {
        this.cancelButtonCallback = callback;
    }

    /**
     * 注册删除按钮回调
     */
    onDeleteButtonClick(callback: (id: string) => void): void {
        this.deleteButtonCallback = callback;
    }

    /**
     * 注册标注选择回调
     */
    onAnnotationSelect(callback: (id: string) => void): void {
        this.annotationSelectCallback = callback;
    }

    /**
     * 注册编辑/更新回调
     * 点击「编辑」时 isUpdate=false，点击「更新」时 isUpdate=true
     */
    onAnnotationEditOrUpdate(callback: (id: string, isUpdate: boolean) => void): void {
        this.annotationEditCallback = callback;
    }

    /** 列表项显隐切换 */
    onVisibilityToggle(callback: (id: string, visible: boolean) => void): void {
        this.visibilityToggleCallback = callback;
    }

    /**
     * 注册输入变化回调
     */
    onInputChange(callback: (data: Partial<AnnotationFormData>) => void): void {
        this.inputChangeCallback = callback;
    }

    /**
     * 销毁组件
     */
    destroy(): void {
        this.container?.remove();
    }
}
