export type BillionsBenchmarkConfig = {
    benchmark: boolean;
    benchmarkAnimTrack: boolean;
    benchmarkHud: boolean;
    benchmarkLabel: string;
    noui: boolean;
    instances?: number;
    settings?: string;
    lodBaseDistance?: number;
    lodMultiplier?: number;
};

const hasFlag = (params: URLSearchParams, key: string) => params.has(key);

export function parseBillionsBenchmarkConfig(): BillionsBenchmarkConfig {
    const params = new URLSearchParams(window.location.search);
    const instancesRaw = params.get('instances');
    const lodBaseRaw = params.get('lodBaseDistance');
    const lodMultRaw = params.get('lodMult') ?? params.get('lodMultiplier');

    return {
        benchmark: hasFlag(params, 'benchmark'),
        benchmarkAnimTrack: hasFlag(params, 'benchmarkAnimTrack'),
        benchmarkHud: hasFlag(params, 'benchmarkHud'),
        benchmarkLabel: params.get('benchmarkLabel') ?? 'billions-default',
        noui: hasFlag(params, 'noui'),
        instances: instancesRaw !== null && instancesRaw !== '' ? Number(instancesRaw) : undefined,
        settings: params.get('settings') ?? undefined,
        lodBaseDistance: lodBaseRaw !== null && lodBaseRaw !== '' ? Number(lodBaseRaw) : undefined,
        lodMultiplier: lodMultRaw !== null && lodMultRaw !== '' ? Number(lodMultRaw) : undefined
    };
}
