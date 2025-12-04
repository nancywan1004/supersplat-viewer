import { Global } from './types';

type PostMessagePayload =
    | {
        type: 'CAMERA_MODE_SWITCH';
        message?: string;
        value: 'orbit' | 'fly';
    }
    | {
        type: 'CAMERA_RESET';
        message?: string;
    }
    | {
        type: 'SKYBOX_SWITCH';
        message?: string;
        value: string;
    }
    | {
        type: 'ANIMATION_PLAY_PAUSE';
        message?: string;
    };

const initPostMessageBridge = (global: Global) => {
    const { state, events, app } = global;

    const handleMessage = async (event: MessageEvent) => {
        const payload = event.data as PostMessagePayload;
        if (!payload?.type) {
            return;
        }

        switch (payload.type) {
        case 'CAMERA_MODE_SWITCH':
            if (payload.value === 'orbit' || payload.value === 'fly') {
                state.cameraMode = payload.value;
            } else {
                console.warn('[SuperSplat] 未知的相机模式：', payload.value);
            }
            break;
        case 'CAMERA_RESET':
            events.fire('inputEvent', 'reset');
            break;
        case 'SKYBOX_SWITCH':
            if (typeof payload.value === 'string') {
                events.fire('skyboxSwitch', payload.value);
            } else {
                console.warn('[SuperSplat] SKYBOX_SWITCH 需要字符串 URL');
            }
            break;
        case 'ANIMATION_PLAY_PAUSE':
            events.fire('inputEvent', 'playPause');
            break;
        default:
            // 交给其他监听者处理
            break;
        }
    };

    window.addEventListener('message', handleMessage);

    // 监听相机模式变化，通知iframe调用侧
    events.on('cameraMode:changed', (value, prev) => {
        // 只通知orbit和fly模式的变化，不通知anim模式
        if (value === 'orbit' || value === 'fly') {
            window.parent.postMessage({
                type: 'CAMERA_MODE_CHANGED',
                value: value
            }, '*');
        }
    });
};

export { initPostMessageBridge };