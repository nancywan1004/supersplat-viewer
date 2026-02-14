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
        type: 'ANIMATION_RESET';
        message?: string;
    }
    | {
        type: 'ANIMATION_PLAY_PAUSE';
        message?: string;
    }
    | { type: 'EDIT_MODE_ENTER'; message?: string }
    | { type: 'EDIT_MODE_EXIT'; message?: string }
    | { type: 'EDIT_MODE_SET'; message?: string; value: boolean };

const initPostMessageBridge = (global: Global) => {
    const { state, events, config } = global;

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
        case 'ANIMATION_RESET':
            events.fire('inputEvent', 'resetAnim');
            break;
        case 'ANIMATION_PLAY_PAUSE':
            events.fire('inputEvent', 'playPause');
            break;
        case 'EDIT_MODE_ENTER':
            if (config.allowEditMode !== false) {
                state.editMode = true;
            }
            break;
        case 'EDIT_MODE_EXIT':
            state.editMode = false;
            break;
        case 'EDIT_MODE_SET':
            if (payload.value === true && config.allowEditMode === false) break;
            state.editMode = !!payload.value;
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
                message: 'camera mode changed',
                value: value
            }, '*');
        }
    });

    // 监听viewer初始化完成事件，通知iframe调用侧
    events.on('firstFrame', () => {
        window.parent.postMessage({
            type: 'VIEWER_READY',
            message: 'viewer initialized and ready'
        }, '*');
    });

    // 监听编辑模式变化，通知父页
    events.on('editMode:changed', (value: boolean) => {
        window.parent.postMessage({
            type: 'EDIT_MODE_CHANGED',
            message: 'edit mode changed',
            value
        }, '*');
    });
};

export { initPostMessageBridge };