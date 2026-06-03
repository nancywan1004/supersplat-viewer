import type { EffectParamKind, EffectParamUiSpec } from './effect-params-ui-schema';

export type EffectParamsPanelHandle = {
    syncFromValues: (values: Record<string, unknown>) => void;
    setVisible: (visible: boolean) => void;
    destroy: () => void;
};

type ControlEntry = {
    spec: EffectParamUiSpec;
    row: HTMLElement;
    write: (value: unknown) => void;
};

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const asTriple = (v: unknown): [number, number, number] | null => {
    if (!Array.isArray(v) || v.length < 3) return null;
    if (!v.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
    return [v[0], v[1], v[2]];
};

const asPair = (v: unknown): [number, number] | null => {
    if (!Array.isArray(v) || v.length < 2) return null;
    if (typeof v[0] !== 'number' || typeof v[1] !== 'number') return null;
    if (!Number.isFinite(v[0]) || !Number.isFinite(v[1])) return null;
    return [v[0], v[1]];
};

const resolveDisplayValue = (spec: EffectParamUiSpec, values: Record<string, unknown>): unknown => {
    if (Object.prototype.hasOwnProperty.call(values, spec.key)) {
        return values[spec.key];
    }
    return spec.default;
};

const formatNumber = (n: number): string => {
    if (Math.abs(n) >= 100) return n.toFixed(1);
    if (Math.abs(n) >= 10) return n.toFixed(2);
    return n.toFixed(3).replace(/\.?0+$/, '');
};

const createNumberControl = (
    spec: EffectParamUiSpec,
    onChange: (key: string, value: number) => void
): ControlEntry => {
    const row = document.createElement('div');
    row.className = 'effectParamRow settingsRow';

    const label = document.createElement('label');
    label.className = 'effectParamLabel';
    label.textContent = spec.label;
    label.title = spec.key;

    const wrap = document.createElement('div');
    wrap.className = 'effectParamControl';

    const useSlider = spec.min !== undefined && spec.max !== undefined;
    const input = document.createElement('input');
    input.type = useSlider ? 'range' : 'number';
    input.className = useSlider ? 'effectParamRange' : 'settingsInput effectParamNumber';
    if (useSlider) {
        input.min = String(spec.min);
        input.max = String(spec.max);
        input.step = String(spec.step ?? 0.01);
    } else if (spec.step !== undefined) {
        input.step = String(spec.step);
    }

    const valueEl = document.createElement('span');
    valueEl.className = 'effectParamValue';

    const emit = () => {
        const num = parseFloat(input.value);
        if (!Number.isFinite(num)) return;
        valueEl.textContent = formatNumber(num);
        onChange(spec.key, num);
    };

    input.addEventListener('input', emit);
    input.addEventListener('change', emit);

    wrap.appendChild(input);
    if (useSlider) wrap.appendChild(valueEl);
    row.appendChild(label);
    row.appendChild(wrap);

    return {
        spec,
        row,
        write: (value: unknown) => {
            const num = isFiniteNumber(value)
                ? value
                : (isFiniteNumber(spec.default as number) ? (spec.default as number) : 0);
            input.value = String(num);
            if (useSlider) valueEl.textContent = formatNumber(num);
        }
    };
};

const createBooleanControl = (
    spec: EffectParamUiSpec,
    onChange: (key: string, value: boolean) => void
): ControlEntry => {
    const row = document.createElement('div');
    row.className = 'effectParamRow settingsRow effectParamRowCheck';

    const check = document.createElement('div');
    check.className = 'checkMark';
    check.textContent = '✓';
    const option = document.createElement('div');
    option.className = 'effectParamCheckLabel';
    option.textContent = spec.label;
    option.title = spec.key;

    const setChecked = (checked: boolean) => {
        check.classList[checked ? 'add' : 'remove']('active');
    };

    const toggle = () => {
        const next = !check.classList.contains('active');
        setChecked(next);
        onChange(spec.key, next);
    };

    check.addEventListener('click', toggle);
    option.addEventListener('click', toggle);
    row.appendChild(check);
    row.appendChild(option);

    return {
        spec,
        row,
        write: (value: unknown) => {
            setChecked(typeof value === 'boolean' ? value : spec.default === true);
        }
    };
};

const createAxisInputs = (
    spec: EffectParamUiSpec,
    axes: string[],
    onChange: (key: string, value: number[]) => void
): ControlEntry => {
    const row = document.createElement('div');
    row.className = 'effectParamRow settingsRow effectParamRowVec';

    const label = document.createElement('label');
    label.className = 'effectParamLabel';
    label.textContent = spec.label;
    label.title = spec.key;

    const wrap = document.createElement('div');
    wrap.className = 'effectParamVecWrap';

    const inputs = axes.map((axis) => {
        const axisWrap = document.createElement('div');
        axisWrap.className = 'effectParamAxis';

        const axisLabel = document.createElement('span');
        axisLabel.className = 'effectParamAxisLabel';
        axisLabel.textContent = axis;

        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'settingsInput effectParamAxisInput';
        input.step = String(spec.step ?? 0.1);
        if (spec.min !== undefined) input.min = String(spec.min);
        if (spec.max !== undefined) input.max = String(spec.max);

        axisWrap.appendChild(axisLabel);
        axisWrap.appendChild(input);
        wrap.appendChild(axisWrap);
        return input;
    });

    const emit = () => {
        const vals = inputs.map((inp) => parseFloat(inp.value));
        if (!vals.every(Number.isFinite)) return;
        onChange(spec.key, vals);
    };

    for (const inp of inputs) {
        inp.addEventListener('change', emit);
    }

    row.appendChild(label);
    row.appendChild(wrap);

    return {
        spec,
        row,
        write: (value: unknown) => {
            let vals: number[];
            if (spec.kind === 'vec2xz') {
                const pair = asPair(value);
                vals = pair ? [pair[0], pair[1]] : asPair(spec.default) ? [...(spec.default as [number, number])] : [0, 0];
            } else {
                const triple = asTriple(value);
                vals = triple ? [...triple] : asTriple(spec.default) ? [...(spec.default as [number, number, number])] : [0, 0, 0];
            }
            for (let i = 0; i < inputs.length; i++) {
                inputs[i].value = String(vals[i] ?? 0);
            }
        }
    };
};

const createEnumControl = (
    spec: EffectParamUiSpec,
    onChange: (key: string, value: number) => void
): ControlEntry => {
    const row = document.createElement('div');
    row.className = 'effectParamRow settingsRow';

    const label = document.createElement('label');
    label.className = 'effectParamLabel';
    label.textContent = spec.label;
    label.title = spec.key;

    const select = document.createElement('select');
    select.className = 'settingsSelect effectParamSelect';

    const options = spec.options ?? [];
    for (const opt of options) {
        const o = document.createElement('option');
        o.value = String(opt.value);
        o.textContent = opt.label;
        select.appendChild(o);
    }

    const emit = () => {
        const num = parseInt(select.value, 10);
        if (!Number.isFinite(num)) return;
        onChange(spec.key, num);
    };

    select.addEventListener('change', emit);
    row.appendChild(label);
    row.appendChild(select);

    return {
        spec,
        row,
        write: (value: unknown) => {
            const num = isFiniteNumber(value)
                ? value
                : (isFiniteNumber(spec.default as number) ? (spec.default as number) : 0);
            select.value = String(num);
        }
    };
};

const createTextControl = (
    spec: EffectParamUiSpec,
    onChange: (key: string, value: string) => void
): ControlEntry => {
    const row = document.createElement('div');
    row.className = 'effectParamRow settingsRow';

    const label = document.createElement('label');
    label.className = 'effectParamLabel';
    label.textContent = spec.label;
    label.title = spec.key;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'settingsInput effectParamText';

    const emit = () => {
        onChange(spec.key, input.value);
    };

    input.addEventListener('change', emit);
    row.appendChild(label);
    row.appendChild(input);

    return {
        spec,
        row,
        write: (value: unknown) => {
            input.value = typeof value === 'string'
                ? value
                : (typeof spec.default === 'string' ? spec.default : '');
        }
    };
};

const createColorControl = (
    spec: EffectParamUiSpec,
    onChange: (key: string, value: [number, number, number]) => void
): ControlEntry => {
    const entry = createAxisInputs(spec, ['R', 'G', 'B'], (key, value) => {
        if (value.length >= 3) onChange(key, [value[0], value[1], value[2]]);
    });
    entry.row.classList.add('effectParamRowColor');
    return entry;
};

const createControl = (
    spec: EffectParamUiSpec,
    onChange: (key: string, value: unknown) => void
): ControlEntry => {
    switch (spec.kind as EffectParamKind) {
    case 'boolean':
        return createBooleanControl(spec, onChange);
    case 'enum':
        return createEnumControl(spec, onChange);
    case 'text':
        return createTextControl(spec, onChange);
    case 'color':
        return createColorControl(spec, onChange);
    case 'vec3':
        return createAxisInputs(spec, ['X', 'Y', 'Z'], onChange);
    case 'vec2xz':
        return createAxisInputs(spec, ['X', 'Z'], onChange);
    default:
        return createNumberControl(spec, onChange);
    }
};

export function mountEffectParamsPanel(input: {
    container: HTMLElement;
    specs: EffectParamUiSpec[];
    onPatch: (partial: Record<string, unknown>) => void;
}): EffectParamsPanelHandle {
    const { container, specs, onPatch } = input;
    container.replaceChildren();

    if (specs.length === 0) {
        container.classList.add('hidden');
        return {
            syncFromValues: () => {},
            setVisible: (visible) => container.classList[visible ? 'remove' : 'add']('hidden'),
            destroy: () => container.replaceChildren()
        };
    }

    const controls: ControlEntry[] = [];
    let suppressEmit = false;

    for (const spec of specs) {
        const control = createControl(spec, (key, value) => {
            if (suppressEmit) return;
            onPatch({ [key]: value });
        });
        controls.push(control);
        container.appendChild(control.row);
    }

    container.classList.remove('hidden');

    return {
        syncFromValues: (values: Record<string, unknown>) => {
            suppressEmit = true;
            try {
                for (const control of controls) {
                    control.write(resolveDisplayValue(control.spec, values));
                }
            } finally {
                suppressEmit = false;
            }
        },
        setVisible: (visible: boolean) => {
            container.classList[visible ? 'remove' : 'add']('hidden');
        },
        destroy: () => {
            container.replaceChildren();
            container.classList.add('hidden');
        }
    };
}
