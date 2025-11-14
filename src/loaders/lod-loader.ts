import type { AppBase, GSplatComponent } from 'playcanvas';
import { Global } from '../types';
import { LodPreset, LodSettings, LodPlatform } from '../schemas/v2';

/**
 * LOD presets for different quality levels
 */
export const LOD_PRESETS: Record<string, LodPreset> = {
    'desktop-max': {
        range: [0, 5],
        lodDistances: [10, 20, 40, 80, 120, 150, 200]
    },
    'desktop': {
        range: [1, 5],
        lodDistances: [5, 10, 25, 50, 65, 90, 150]
    },
    'mobile-max': {
        range: [2, 5],
        lodDistances: [5, 7, 12, 25, 75, 120, 200]
    },
    'mobile': {
        range: [3, 5],
        lodDistances: [2, 4, 6, 10, 75, 120, 200]
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

/**
 * LOD Loader for managing LOD streaming in supersplat-viewer
 */
export class LodLoader {
    private app: AppBase;
    private config: LodSettings

    constructor(global: Global) {
        this.app = global.app;
        this.config = {
            presets: global.settings.lodSettings?.presets ?? LOD_PRESETS,
            lodUpdateDistance: global.settings.lodSettings?.lodUpdateDistance ?? 0.5,
            lodUnderfillLimit: global.settings.lodSettings?.lodUnderfillLimit ?? 5,
            cameraPosition: global.settings.lodSettings?.cameraPosition ?? [0, 0, 0],
            eulerAngles: global.settings.lodSettings?.eulerAngles ?? [-90, 0, 0],
            moveSpeed: global.settings.lodSettings?.moveSpeed ?? 4,
            moveFastSpeed: global.settings.lodSettings?.moveFastSpeed ?? 15,
            enableOrbit: global.settings.lodSettings?.enableOrbit ?? false,
            enablePan: global.settings.lodSettings?.enablePan ?? false,
            focusPoint: global.settings.lodSettings?.focusPoint ?? [0, 0, -1],
            lodUpdateAngle: 90,
            lodBehindPenalty: 5,
            radialSorting: true,
            colorizeLod: !!global.config.colorizeLod
        };
    }

    /**
     * Check if LOD should be enabled for the given URL
     */
    shouldEnableLod(url: string): boolean {
        return isLodMetaFile(url);
    }

    /**
     * Initialize LOD settings on the app
     */
    initializeLodSettings(): void {
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
        gsplatScene.colorizeLod = this.config.colorizeLod;

        console.log('LOD settings initialized:', {
            lodUpdateAngle: gsplatScene.lodUpdateAngle,
            lodBehindPenalty: gsplatScene.lodBehindPenalty,
            radialSorting: gsplatScene.radialSorting,
            lodUpdateDistance: gsplatScene.lodUpdateDistance,
            lodUnderfillLimit: gsplatScene.lodUnderfillLimit,
            colorizeLod: gsplatScene.colorizeLod
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
            return isHighPerformance ? 'mobile-max' : 'mobile';
        } else {
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
        const platform = this.detectPlatform();
        const preset = this.config.presets[platform];

        console.log('Using preset:', platform, preset);

        const gsplatScene = (this.app.scene as any).gsplat;
        if (gsplatScene) {
            gsplatScene.lodRangeMin = preset.range[0];
            gsplatScene.lodRangeMax = preset.range[1];
            console.log('Set LOD range:', preset.range);
        }

        // Apply LOD distances to the component
        const gsplat = gsplatComponent as any;
        console.log('GSplat component:', gsplat);
        
        if (gsplat && preset.lodDistances) {
            gsplat.lodDistances = preset.lodDistances;
            console.log('LOD preset applied:', {
                preset: this.config.preset,
                range: preset.range,
                lodDistances: preset.lodDistances
            });
        } else {
            console.warn('Could not apply LOD distances to component');
        }
    }
}
