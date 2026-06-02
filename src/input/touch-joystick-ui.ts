/**
 * Touch joystick is shown in landscape touch mode. It only contributes movement
 * in first-person camera modes; scene gestures remain active.
 */
const isLandscapeOrientation = (): boolean =>
    window.matchMedia('(orientation: landscape)').matches;

const shouldUseTouchJoystickMove = (state: {
    inputMode: string;
}): boolean => (
    state.inputMode === 'touch' &&
    isLandscapeOrientation()
);

export { isLandscapeOrientation, shouldUseTouchJoystickMove };
