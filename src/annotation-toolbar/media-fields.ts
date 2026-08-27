/**
 * 标注媒体：协议/表单每个槽为 `string | File`；settings 仍为 imageUrl/videoUrl 字符串。
 * image 与 video 互斥，同时存在时保留 video。
 */
import type { Annotation, Camera } from '../schemas/v2';
import type { AnnotationData } from './types';

/** 协议入站：远程 URL 或用户 File。ingest 之后运行态只保留字符串。 */
export type AnnotationMediaInput = string | File;

export type AnnotationMediaFields = {
    imageUrl?: string;
    videoUrl?: string;
};

const DEFAULT_ANNOTATION_CAMERA: Camera = {
    initial: { position: [0, 0, 0], target: [0, 0, 0], fov: 60 }
};

export function annotationMediaUrl(media?: AnnotationMediaInput | null): string | undefined {
    if (typeof media !== 'string') return undefined;
    const url = media.trim();
    return url || undefined;
}

export function normalizeAnnotationMediaFields(data: AnnotationMediaFields): AnnotationMediaFields {
    const imageUrl = typeof data.imageUrl === 'string' && data.imageUrl.length > 0
        ? data.imageUrl
        : undefined;
    const videoUrl = typeof data.videoUrl === 'string' && data.videoUrl.length > 0
        ? data.videoUrl
        : undefined;

    if (videoUrl) {
        return { videoUrl };
    }
    if (imageUrl) {
        return { imageUrl };
    }
    return {};
}

export function annotationSlotsFromUrls(fields: AnnotationMediaFields): {
    image?: string;
    video?: string;
} {
    const media = normalizeAnnotationMediaFields(fields);
    if (media.videoUrl) return { video: media.videoUrl };
    if (media.imageUrl) return { image: media.imageUrl };
    return {};
}

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

export function settingsToAnnotationData(ann: Annotation): AnnotationData {
    const { imageUrl, videoUrl, extras: _extras, camera: _camera, ...rest } = ann;
    return {
        ...rest,
        ...annotationSlotsFromUrls({ imageUrl, videoUrl })
    };
}
