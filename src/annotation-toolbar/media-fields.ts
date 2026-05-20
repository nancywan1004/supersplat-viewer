/**
 * Annotation image/video media fields — mutually exclusive (video wins if both set).
 */
export type AnnotationMediaFields = {
    imageUrl?: string;
    videoUrl?: string;
};

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
