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
        default:
            // 交给其他监听者处理
            break;
        }
    };

    window.addEventListener('message', handleMessage);
};

export { initPostMessageBridge };