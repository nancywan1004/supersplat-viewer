import type { Global } from '../types';

export type EditUiTransport = 'internal' | 'message-bridge';

export function getEditUiTransport(global: Global): EditUiTransport {
    return global.config.editUiTransport === 'message-bridge' ? 'message-bridge' : 'internal';
}

/**
 * 内部编辑 UI 通过协议命令驱动（由 message-bridge 处理）。
 * 这里使用 window.postMessage（同窗口），从而：
 * - message-bridge 的 window.addEventListener('message') 可以接收并执行
 * - E2E 可通过监听 window message 来抓包断言
 */
export function sendEditProtocolMessage(message: { type: string; [k: string]: unknown }): void {
    console.log('[EditUiTransport] sendEditProtocolMessage', message);
    window.postMessage(message, '*');
}

