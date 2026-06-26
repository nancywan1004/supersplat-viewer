import type { AppBase, GSplatComponent } from 'playcanvas';
import { Global } from '../../../types';
import type { ExperienceSettings } from '../../../schemas/v2';
import { LodPreset, LodSettings, LodPlatform } from '../../../schemas/v2';

/**
 * LOD presets for different quality levels
 */
export const LOD_PRESETS: Record<string, LodPreset> = {
    'desktop-max': {
        range: [0, 5],
        lodDistances: [10, 20, 40, 80, 120, 150, 200],
        splatBudget: 6
    },
    'desktop': {
        range: [1, 5],
        lodDistances: [5, 10, 25, 50, 65, 90, 150],
        splatBudget: 3
    },
    'mobile-max': {
        range: [1, 5],
        lodDistances: [5, 7, 12, 25, 75, 120, 200],
        splatBudget: 2
    },
    'mobile': {
        range: [2, 5],
        lodDistances: [2, 4, 6, 10, 75, 120, 200],
        splatBudget: 1
    }
};

/**
 * Check if a URL points to a LOD meta file
 */
export function isLodMetaFile(url: string): boolean {
    const urlWithoutParams = url.indexOf('?') >= 0 ? url.split('?')[0] : url;
    const filename = urlWithoutParams.split('/').pop()?.toLowerCase() || '';
    return filename === 'lod-meta.json';
}

/** settings 含 lodSettings 且场景 URL 为 lod-meta.json 时才走自定义 LodLoader 管线 */
export function isCustomLodEnabled(
    settings: Pick<ExperienceSettings, 'lodSettings'> | undefined,
    contentUrl: string | undefined
): boolean {
    return !!settings?.lodSettings && !!contentUrl && isLodMetaFile(contentUrl);
}

export function isGsplatMetaJsonFilename(filename: string | undefined): boolean {
    const name = filename?.toLowerCase() ?? '';
    return name === 'meta.json' || name === 'lod-meta.json';
}

/**
 * LOD Loader for managing LOD streaming in supersplat-viewer
 */
export class LodLoader {
    private app: AppBase;
    private config: LodSettings;
    private readonly enabled: boolean;

    constructor(global: Global) {
        this.app = global.app;
        this.enabled = !!global.settings.lodSettings;
        const lodSettings = global.settings.lodSettings;
        this.config = {
            presets: lodSettings?.presets ?? LOD_PRESETS,
            lodUpdateDistance: lodSettings?.lodUpdateDistance ?? 0.5,
            lodUnderfillLimit: lodSettings?.lodUnderfillLimit ?? 5,
            cameraPosition: lodSettings?.cameraPosition ?? [0, 0, 0],
            eulerAngles: lodSettings?.eulerAngles ?? [-90, 0, 0],
            moveSpeed: lodSettings?.moveSpeed ?? 4,
            moveFastSpeed: lodSettings?.moveFastSpeed ?? 15,
            enableOrbit: lodSettings?.enableOrbit ?? false,
            enablePan: lodSettings?.enablePan ?? false,
            focusPoint: lodSettings?.focusPoint ?? [0, 0, -1],
            lodUpdateAngle: 90,
            lodBehindPenalty: 5,
            radialSorting: true
        };
    }

    /**
     * Check if LOD should be enabled for the given URL
     */
    shouldEnableLod(url: string): boolean {
        return this.enabled && isLodMetaFile(url);
    }

    /**
     * Initialize LOD settings on the app
     */
    initializeLodSettings(): void {
        if (!this.enabled) {
            return;
        }
        const gsplatScene = (this.app.scene as any).gsplat;
        console.log('GSplat scene object:', gsplatScene);
        
        if (!gsplatScene) {
            console.warn('GSplat scene not available for LOD configuration');
            return;
        }

        // Apply LOD scene settings
        gsplatScene.lodUpdateAngle = this.config.lodUpdateAngle;
        gsplatScene.lodBehindPenalty = this.config.lodBehindPenalty;
        gsplatScene.radialSorting = this.config.radialSorting;
        gsplatScene.lodUpdateDistance = this.config.lodUpdateDistance;
        gsplatScene.lodUnderfillLimit = this.config.lodUnderfillLimit;

        console.log('LOD settings initialized:', {
            lodUpdateAngle: gsplatScene.lodUpdateAngle,
            lodBehindPenalty: gsplatScene.lodBehindPenalty,
            radialSorting: gsplatScene.radialSorting,
            lodUpdateDistance: gsplatScene.lodUpdateDistance,
            lodUnderfillLimit: gsplatScene.lodUnderfillLimit
        });
    }

    /**
     * Detect current platform and performance level
     */
    private detectPlatform(): LodPlatform {
        // Check for mobile devices
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
        
        // Check for touch support as additional indicator
        const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
        
        // Check screen size
        const isSmallScreen = window.innerWidth <= 768;
        
        const isMobileDevice = isMobile || (hasTouch && isSmallScreen);
        
        // Detect device performance level
        const isHighPerformance = this.detectHighPerformance();
        
        if (isMobileDevice) {
            console.log('Mobile device detected: ' + isHighPerformance ? 'high performance' : 'low performance');
            return isHighPerformance ? 'mobile-max' : 'mobile';
        } else {
            console.log('Desktop device detected: ' + isHighPerformance ? 'high performance' : 'low performance');
            return isHighPerformance ? 'desktop-max' : 'desktop';
        }
    }

    /**
     * Detect if device has high performance capabilities
     */
    private detectHighPerformance(): boolean {
        // Check hardware concurrency (CPU cores)
        const cores = navigator.hardwareConcurrency || 2;
        
        // Check device memory (in GB)
        const memory = (navigator as any).deviceMemory || 4;
        
        // Check for high-end GPU hints
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        let hasHighEndGPU = false;
        
        if (gl) {
            const debugInfo = (gl as any).getExtension('WEBGL_debug_renderer_info');
            if (debugInfo) {
                const renderer = (gl as any).getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
                // Check for high-end GPU indicators
                hasHighEndGPU = /NVIDIA|AMD|Radeon|GeForce|RTX|GTX|Apple M[0-9]|Apple GPU/i.test(renderer);
            }
        }
        
        // High performance if: 6+ cores OR 8GB+ memory OR high-end GPU
        return cores >= 6 || memory >= 8 || hasHighEndGPU;
    }

    /**
     * Apply LOD preset to a GSplat component
     */
    applyLodPreset(gsplatComponent: GSplatComponent): void {
        if (!this.enabled) {
            return;
        }
        const platform = this.detectPlatform();
        const preset = this.config.presets[platform];

        console.log('Using preset:', platform, preset);

        const gsplat = gsplatComponent as GSplatComponent & {
            lodDistances?: number[];
            splatBudget?: number;
        };
        gsplat.lodRangeMin = preset.range[0];
        gsplat.lodRangeMax = preset.range[1];
        if (preset.splatBudget !== undefined) {
            gsplat.splatBudget = preset.splatBudget * 1_000_000;
        }
        if (preset.lodDistances) {
            gsplat.lodDistances = preset.lodDistances;
        }

        console.log('LOD preset applied to component:', {
            preset: platform,
            range: preset.range,
            splatBudget: preset.splatBudget,
            lodDistances: preset.lodDistances
        });
    }
}
