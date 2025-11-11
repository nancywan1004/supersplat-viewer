/* eslint-disable no-unused-vars */
interface Window {
    sse: {
        poster?: HTMLImageElement,
        settings: Promise<object>,
        contentUrl: string,
        contents: ArrayBuffer,
        params: Record<string, string>
    }

    firstFrame?: () => void;
}

declare module 'playcanvas/scripts/esm/xr-controllers.mjs' {
    const XrControllers: any;
    export { XrControllers };
}

declare module 'playcanvas/scripts/esm/xr-navigation.mjs' {
    const XrNavigation: any;
    export { XrNavigation };
}

// declare module 'playcanvas/scripts/esm/gsplat/reveal-radial.mjs' {
//     const GsplatRevealRadial: any;
//     export { GsplatRevealRadial };
// }

// declare module 'playcanvas/scripts/esm/gsplat/reveal-rain.mjs' {
//     const GsplatRevealRain: any;
//     export { GsplatRevealRain };
// }

// Local script modules
declare module '*/gsplat-reveal-radial.ts' {
    const GsplatRevealRadial: any;
    export { GsplatRevealRadial };
}

declare module '*/gsplat-reveal-rain.ts' {
    const GsplatRevealRain: any;
    export { GsplatRevealRain };
}

declare module '*/gsplat-shader-effect.ts' {
    const GsplatShaderEffect: any;
    export { GsplatShaderEffect };
}

declare module '*.html' {
    const content: string;
    export default content;
}

declare module '*.css' {
    const content: string;
    export default content;
}

declare module '*.js' {
    const content: string;
    export default content;
}
