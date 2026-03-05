/**
 * 标注工具栏 UI 组件
 * 负责右侧工具栏的显示、标注编辑表单和标注列表
 */

import type { AnnotationFormData, AnnotationData } from '../../annotation-toolbar/types';

export class AnnotationToolbarUI {
    private container: HTMLElement | null = null;
    private editForm: HTMLElement | null = null;
    private annotationList: HTMLElement | null = null;
    private createButton: HTMLButtonElement | null = null;
    private confirmButton: HTMLButtonElement | null = null;
    private cancelButton: HTMLButtonElement | null = null;
    private titleInput: HTMLInputElement | null = null;
    private textInput: HTMLTextAreaElement | null = null;
    private imageInput: HTMLInputElement | null = null;
    private imagePreview: HTMLImageElement | null = null;
    private showTitleCheckbox: HTMLInputElement | null = null;
    private titleCharCount: HTMLElement | null = null;
    private textCharCount: HTMLElement | null = null;
    private placementHint: HTMLElement | null = null;

    // 回调函数
    private createButtonCallback: (() => void) | null = null;
    private confirmButtonCallback: ((data: AnnotationFormData) => void) | null = null;
    private cancelButtonCallback: (() => void) | null = null;
    private deleteButtonCallback: ((id: string) => void) | null = null;
    private annotationSelectCallback: ((id: string) => void) | null = null;
    private annotationEditCallback: ((id: string, isUpdate: boolean) => void) | null = null;
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

        // 图片上传
        const imageGroup = document.createElement('div');
        imageGroup.className = 'annotation-form-group';
        
        const imageLabel = document.createElement('label');
        imageLabel.textContent = '图片';
        imageLabel.className = 'annotation-form-label';
        imageGroup.appendChild(imageLabel);

        this.imageInput = document.createElement('input');
        this.imageInput.type = 'file';
        this.imageInput.className = 'annotation-form-file-input';
        this.imageInput.accept = 'image/*';
        imageGroup.appendChild(this.imageInput);

        this.imagePreview = document.createElement('img');
        this.imagePreview.className = 'annotation-image-preview hidden';
        imageGroup.appendChild(this.imagePreview);

        form.appendChild(imageGroup);

        // "收起时显示标题"复选框
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

        // 按钮组
        const buttonGroup = document.createElement('div');
        buttonGroup.className = 'annotation-form-buttons';

        this.cancelButton = document.createElement('button');
        this.cancelButton.className = 'annotation-form-btn annotation-cancel-btn';
        this.cancelButton.textContent = '取消';
        buttonGroup.appendChild(this.cancelButton);

        this.confirmButton = document.createElement('button');
        this.confirmButton.className = 'annotation-form-btn annotation-confirm-btn';
        this.confirmButton.textContent = '确定并放置';
        buttonGroup.appendChild(this.confirmButton);

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

    /**
     * 绑定事件
     */
    private bindEvents(): void {
        // 创建按钮点击
        this.createButton?.addEventListener('click', () => {
            this.createButtonCallback?.();
        });

        // 确认/更新按钮点击
        this.confirmButton?.addEventListener('click', () => {
            if (this.isEditMode && this.editingAnnotationId) {
                this.annotationEditCallback?.(this.editingAnnotationId, true);
            } else {
                this.confirmButtonCallback?.(this.getFormData());
            }
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

        // 图片上传
        this.imageInput?.addEventListener('change', (e) => {
            const target = e.target as HTMLInputElement;
            const file = target.files?.[0];
            if (file) {
                this.handleImageUpload(file);
            }
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
        // 验证文件类型
        if (!file.type.startsWith('image/')) {
            alert('请选择有效的图片文件');
            return;
        }

        // 验证文件大小（限制为 5MB）
        const maxSize = 5 * 1024 * 1024;
        if (file.size > maxSize) {
            alert('图片文件大小不能超过 5MB');
            return;
        }

        // 读取文件并转换为 Data URL
        const reader = new FileReader();
        reader.onload = (e) => {
            const dataUrl = e.target?.result as string;
            if (this.imagePreview) {
                this.imagePreview.src = dataUrl;
                this.imagePreview.classList.remove('hidden');
            }
            this.notifyInputChange();
        };
        reader.onerror = () => {
            alert('图片读取失败，请重试');
        };
        reader.readAsDataURL(file);
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
        if (this.inputChangeCallback) {
            const data = this.getFormData();
            this.inputChangeCallback(data);
        }
    }

    /**
     * 获取表单数据（公开供外部读取当前表单内容）
     */
    getFormData(): AnnotationFormData {
        return {
            title: this.titleInput?.value || '',
            text: this.textInput?.value || '',
            imageUrl: this.imagePreview?.src || undefined,
            showTitleWhenCollapsed: this.showTitleCheckbox?.checked || false
        };
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
            if (annotation.imageUrl && this.imagePreview) {
                this.imagePreview.src = annotation.imageUrl;
                this.imagePreview.classList.remove('hidden');
            } else if (this.imagePreview) {
                this.imagePreview.src = '';
                this.imagePreview.classList.add('hidden');
            }
            // 清空文件选择，避免沿用上次上传的文件
            if (this.imageInput) this.imageInput.value = '';
        } else {
            // 清空表单
            if (this.titleInput) this.titleInput.value = '';
            if (this.textInput) this.textInput.value = '';
            if (this.showTitleCheckbox) this.showTitleCheckbox.checked = false;
            if (this.imagePreview) {
                this.imagePreview.classList.add('hidden');
                this.imagePreview.src = '';
            }
            if (this.imageInput) this.imageInput.value = '';
        }
        this.updateCharCount();
        this.confirmButton!.textContent = isEditMode ? '更新' : '确定并放置';
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
     */
    updateAnnotationList(annotations: AnnotationData[], editingId?: string | null): void {
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

        // 渲染标注列表项
        annotations.forEach((annotation) => {
            const item = document.createElement('div');
            item.className = 'annotation-list-item';
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

            // 点击列表项选择标注（仅显示 Gizmo，不显示编辑表单）
            itemContent.addEventListener('click', () => {
                this.annotationSelectCallback?.(annotation.id);
                listContainer.querySelectorAll('.annotation-list-item').forEach((el) => {
                    el.classList.remove('selected');
                });
                item.classList.add('selected');
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
