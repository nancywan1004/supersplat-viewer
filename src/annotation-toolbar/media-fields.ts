/**
 * 标注媒体：协议/表单每个槽为 `string | File`；settings 仍为 imageUrl/videoUrl 字符串。
 * image 与 video 互斥，同时存在时保留 video。
 */
import type { AnnotationData } from './types';
import type { Annotation, Camera } from '../schemas/v2';

/** 协议入站：远程 URL 或用户 File。ingest 之后运行态只保留字符串。 */
export type AnnotationMediaInput = string | File;

export type AnnotationMediaFields = {
    imageUrl?: string;
    videoUrl?: string;
};

const DEFAULT_ANNOTATION_CAMERA: Camera = {
    initial: { position: [0, 0, 0], target: [0, 0, 0], fov: 60 }
};

/**
 * 字符串槽转 URL；File 返回 undefined（由 persist 入库）。
 * @param media - 协议/表单槽
 * @returns 非空字符串 URL
 */
export function annotationMediaUrl(media?: AnnotationMediaInput | null): string | undefined {
    if (typeof media !== 'string') return undefined;
    const url = media.trim();
    return url || undefined;
}

function mediaString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const url = value.trim();
    return url || undefined;
}

/**
 * 从 settings 标注或运行态槽读取媒体 URL。
 * 存盘字段为 imageUrl/videoUrl；若误写成 image/video 字符串也认。
 * @param raw - 标注对象
 * @returns 互斥后的 imageUrl / videoUrl
 */
export function annotationMediaFromUnknown(raw: unknown): AnnotationMediaFields {
    if (!raw || typeof raw !== 'object') return {};
    const rec = raw as Record<string, unknown>;
    return normalizeAnnotationMediaFields({
        imageUrl: mediaString(rec.imageUrl) ?? mediaString(rec.image),
        videoUrl: mediaString(rec.videoUrl) ?? mediaString(rec.video)
    });
}

/**
 * 把标注记录收成 settings 的 imageUrl/videoUrl，去掉运行态 image/video 槽。
 * @param rec - 可变标注对象
 */
export function writeAnnotationMediaToSettingsRecord(rec: Record<string, unknown>): void {
    const media = annotationMediaFromUnknown(rec);
    delete rec.image;
    delete rec.video;
    if (media.imageUrl) rec.imageUrl = media.imageUrl;
    else delete rec.imageUrl;
    if (media.videoUrl) rec.videoUrl = media.videoUrl;
    else delete rec.videoUrl;
}

/**
 * 图片与视频互斥，同时存在时保留 video。
 * @param data - imageUrl / videoUrl
 * @returns 至多一个媒体字段
 */
export function normalizeAnnotationMediaFields(data: AnnotationMediaFields): AnnotationMediaFields {
    const imageUrl = typeof data.imageUrl === 'string' && data.imageUrl.length > 0 ?
        data.imageUrl :
        undefined;
    const videoUrl = typeof data.videoUrl === 'string' && data.videoUrl.length > 0 ?
        data.videoUrl :
        undefined;

    if (videoUrl) {
        return { videoUrl };
    }
    if (imageUrl) {
        return { imageUrl };
    }
    return {};
}

/**
 * settings 媒体字段转运行态 image/video 槽。
 * @param fields - imageUrl / videoUrl
 * @returns 运行态槽
 */
export function annotationSlotsFromUrls(fields: AnnotationMediaFields): {
    image?: string;
    video?: string;
} {
    const media = normalizeAnnotationMediaFields(fields);
    if (media.videoUrl) return { video: media.videoUrl };
    if (media.imageUrl) return { image: media.imageUrl };
    return {};
}

/**
 * 运行态 image/video 槽转 settings 媒体字段（忽略 File）。
 * @param value - 运行态槽
 * @returns imageUrl / videoUrl
 */
export function flattenAnnotationMedia(value: {
    image?: AnnotationMediaInput;
    video?: AnnotationMediaInput;
} | undefined): AnnotationMediaFields {
    if (!value) return {};
    return normalizeAnnotationMediaFields({
        imageUrl: annotationMediaUrl(value.image),
        videoUrl: annotationMediaUrl(value.video)
    });
}

/**
 * 运行态标注写成 settings 条目。
 * @param data - 运行态数据
 * @param meta - extras / camera
 * @param meta.extras - 附加字段
 * @param meta.camera - 观察机位
 * @returns settings 标注
 */
export function annotationDataToSettings(
    data: AnnotationData,
    meta?: { extras?: Annotation['extras']; camera?: Camera }
): Annotation {
    const { image, video, ...rest } = data;
    return {
        ...rest,
        ...flattenAnnotationMedia({ image, video }),
        extras: meta?.extras && typeof meta.extras === 'object' ? meta.extras : {},
        camera: meta?.camera ?? DEFAULT_ANNOTATION_CAMERA
    };
}

/**
 * settings 标注写成运行态数据。
 * @param ann - settings 标注
 * @returns 运行态数据
 */
export function settingsToAnnotationData(ann: Annotation): AnnotationData {
    return {
        id: ann.id,
        position: ann.position,
        title: ann.title,
        text: ann.text,
        showTitleWhenCollapsed: ann.showTitleWhenCollapsed,
        collapsed: ann.collapsed,
        visible: ann.visible,
        ...annotationSlotsFromUrls(annotationMediaFromUnknown(ann))
    };
}
