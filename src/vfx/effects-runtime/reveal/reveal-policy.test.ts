/**
 * revealBlocksAnim 自检（无测试框架；`npx tsx` 直接跑）。
 *
 *   npx --yes tsx src/vfx/effects-runtime/reveal/reveal-policy.test.ts
 */

import { revealBlocksAnim } from './reveal-policy';
import type { State } from '../../../types';

function assert(cond: boolean, msg: string): void {
    if (!cond) {
        throw new Error(msg);
    }
}

function stateWithReveal(
    activeType: string,
    status: 'inactive' | 'playing' | 'completed'
): Pick<State, 'hasRevealEffect' | 'effectsRuntimeState'> {
    return {
        hasRevealEffect: true,
        effectsRuntimeState: {
            reveal: {
                activeEffectId: 'scene.gsplat-reveal',
                activeType: activeType as never,
                status
            },
            persistent: {
                activeEffectId: 'scene.gsplat-persistent-scene',
                status: 'inactive'
            },
            asset: {
                activeEffectId: '',
                instances: {}
            }
        }
    };
}

function run(): void {
    const playing = stateWithReveal('growth-wave', 'playing');
    assert(revealBlocksAnim(playing) === true, 'playing timed reveal blocks anim');
    assert(
        revealBlocksAnim(playing, { autoStart: false, type: 'growth-wave' }) === false,
        'autoStart:false does not block even while type is set'
    );
    assert(
        revealBlocksAnim(stateWithReveal('growth-wave', 'completed')) === false,
        'completed timed reveal does not block'
    );
    assert(
        revealBlocksAnim(stateWithReveal('growth-wave', 'inactive'), { autoStart: true }) === true,
        'inactive + autoStart true still holds anim until playing/complete'
    );
    assert(
        revealBlocksAnim(stateWithReveal('perlin-wave', 'playing')) === false,
        'persistent type does not block'
    );
    assert(
        revealBlocksAnim({ hasRevealEffect: false }) === false,
        'no reveal does not block'
    );
    console.log('reveal-policy.test.ts: ok');
}

run();
