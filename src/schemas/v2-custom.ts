type RevealEffect = {
    enabled?: boolean,
    type?: 'radial' | 'rain' | 'grid',
    center?: number[], // [0, 0, 0]
    duration?: number, // 3.0
    radius?: number, // 10
    autoStart?: boolean
}

export type { RevealEffect };
