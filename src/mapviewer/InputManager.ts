import { vec2 } from "gl-matrix";
import { IJoystickUpdateEvent } from "react-joystick-component/build/lib/Joystick";

export function getMousePos(container: HTMLElement, event: MouseEvent | Touch): vec2 {
    const rect = container.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    return [x, y];
}

export function getAxisDeadzone(axis: number, zone: number): number {
    if (Math.abs(axis) < zone) {
        return 0;
    } else if (axis < 0) {
        return axis + zone;
    } else {
        return axis - zone;
    }
}

// Pixels a right press can move and still count as a click (opening the menu) rather than a pan.
const PAN_CLICK_THRESHOLD = 4;

// Wheel pixels per e-fold of pinch spread. Wheel zoom scales by exp(0.0015 per pixel) in ortho and
// while following, so there the view tracks the fingers.
const PINCH_WHEEL_PIXELS = 1 / 0.0015;

function getTouchMidpoint(container: HTMLElement, touches: TouchList): vec2 {
    const [x0, y0] = getMousePos(container, touches[0]);
    const [x1, y1] = getMousePos(container, touches[1]);
    return [(x0 + x1) / 2, (y0 + y1) / 2];
}

function getTouchDistance(touches: TouchList): number {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.max(Math.hypot(dx, dy), 1);
}

export class InputManager {
    element?: HTMLElement;

    keys: Map<string, boolean> = new Map();

    mouseX: number = -1;
    mouseY: number = -1;

    lastMouseX: number = -1;
    lastMouseY: number = -1;

    dragX: number = -1;
    dragY: number = -1;

    deltaMouseX: number = 0;
    deltaMouseY: number = 0;

    // Accumulated wheel scroll (pixels, positive = towards the user) since the last read.
    wheelDelta: number = 0;

    // Right-button drag pans the camera. A right click that doesn't move opens the menu on release.
    panX: number = -1;
    panY: number = -1;
    private panStartX: number = -1;
    private panStartY: number = -1;
    private panMoved: boolean = false;

    // Touch mirrors the mouse: one finger drags like the left button, two fingers pan like a right
    // drag and pinch like the wheel. Finger spread at the last touch event, -1 with under two fingers.
    private pinchDistance: number = -1;

    pickX: number = -1;
    pickY: number = -1;

    positionJoystickEvent?: IJoystickUpdateEvent;
    cameraJoystickEvent?: IJoystickUpdateEvent;

    gamepadIndex?: number;

    init(element: HTMLElement) {
        if (!this.element) {
            this.cleanUp();
        }
        this.element = element;

        window.addEventListener("gamepadconnected", this.onGamepadConnected);
        window.addEventListener("gamepaddisconnected", this.onGamepadDisconnected);

        element.addEventListener("dblclick", this.onDoubleClick);

        element.addEventListener("keydown", this.onKeyDown);
        element.addEventListener("keyup", this.onKeyUp);

        element.addEventListener("mousedown", this.onMouseDown);
        element.addEventListener("mousemove", this.onMouseMove);
        element.addEventListener("mouseup", this.onMouseUp);
        element.addEventListener("mouseleave", this.onMouseLeave);

        element.addEventListener("touchstart", this.onTouchStart, { passive: false });
        element.addEventListener("touchmove", this.onTouchMove, { passive: false });
        element.addEventListener("touchend", this.onTouchEnd);
        element.addEventListener("touchcancel", this.onTouchEnd);

        element.addEventListener("contextmenu", this.onContextMenu);

        element.addEventListener("focusout", this.onFocusOut);

        element.addEventListener("wheel", this.onWheel, { passive: false });
    }

    cleanUp() {
        if (!this.element) {
            return;
        }

        window.removeEventListener("gamepadconnected", this.onGamepadConnected);
        window.removeEventListener("gamepaddisconnected", this.onGamepadDisconnected);

        this.element.removeEventListener("dblclick", this.onDoubleClick);

        this.element.removeEventListener("keydown", this.onKeyDown);
        this.element.removeEventListener("keyup", this.onKeyUp);

        this.element.removeEventListener("mousedown", this.onMouseDown);
        this.element.removeEventListener("mousemove", this.onMouseMove);
        this.element.removeEventListener("mouseup", this.onMouseUp);
        this.element.removeEventListener("mouseleave", this.onMouseLeave);

        this.element.removeEventListener("touchstart", this.onTouchStart);
        this.element.removeEventListener("touchmove", this.onTouchMove);
        this.element.removeEventListener("touchend", this.onTouchEnd);
        this.element.removeEventListener("touchcancel", this.onTouchEnd);

        this.element.removeEventListener("contextmenu", this.onContextMenu);

        this.element.removeEventListener("focusout", this.onFocusOut);

        this.element.removeEventListener("wheel", this.onWheel);
    }

    // Returns the scroll since the last call (lines and pages normalised to pixels).
    takeWheelDelta(): number {
        const delta = this.wheelDelta;
        this.wheelDelta = 0;
        return delta;
    }

    private onWheel = (event: WheelEvent) => {
        event.preventDefault();
        const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
        this.wheelDelta += event.deltaY * scale;
    };

    isShiftDown(): boolean {
        return this.isKeyDown("ShiftLeft") || this.isKeyDown("ShiftRight");
    }

    isKeyDown(key: string): boolean {
        return this.keys.has(key);
    }

    isKeyDownEvent(key: string): boolean {
        return !!this.keys.get(key);
    }

    isDragging(): boolean {
        return this.dragX !== -1 && this.dragY !== -1;
    }

    isPanning(): boolean {
        return this.panX !== -1 && this.panY !== -1;
    }

    // Mouse movement to pan by this frame, once a right drag has moved past the click threshold.
    getPanDeltaX(): number {
        return this.isPanning() && this.panMoved ? this.mouseX - this.panX : 0;
    }

    getPanDeltaY(): number {
        return this.isPanning() && this.panMoved ? this.mouseY - this.panY : 0;
    }

    isPointerLock(): boolean {
        return document.pointerLockElement === this.element;
    }

    isFocused(): boolean {
        return this.mouseX !== -1 && this.mouseY !== -1;
    }

    hasMovedMouse(): boolean {
        return this.lastMouseX !== this.mouseX || this.lastMouseY !== this.mouseY;
    }

    getDeltaMouseX(): number {
        if (this.isPointerLock()) {
            return this.deltaMouseX;
        }
        if (this.isDragging()) {
            return this.dragX - this.mouseX;
        }
        return 0;
    }

    getDeltaMouseY(): number {
        if (this.isPointerLock()) {
            return this.deltaMouseY;
        }
        if (this.isDragging()) {
            return this.dragY - this.mouseY;
        }
        return 0;
    }

    getGamepad(): Gamepad | null {
        let gamepad: Gamepad | null = null;
        if (this.gamepadIndex !== undefined) {
            const gamepads = navigator.getGamepads();
            if (gamepads) {
                gamepad = gamepads[this.gamepadIndex];
            }
        }
        return gamepad;
    }

    private onGamepadConnected = (event: GamepadEvent) => {
        this.gamepadIndex = event.gamepad.index;
    };

    private onGamepadDisconnected = (event: GamepadEvent) => {
        this.gamepadIndex = undefined;
    };

    private onDoubleClick = (event: MouseEvent) => {
        if (!document.pointerLockElement && this.element) {
            this.element.requestPointerLock?.();
        }
    };

    private onKeyDown = (event: KeyboardEvent) => {
        event.preventDefault();
        this.keys.set(event.code, true);
    };

    private onKeyUp = (event: KeyboardEvent) => {
        event.preventDefault();
        this.keys.delete(event.code);
    };

    private onMouseDown = (event: MouseEvent) => {
        if (!this.element) {
            return;
        }
        const [x, y] = getMousePos(this.element, event);
        if (event.button === 2) {
            this.panX = this.panStartX = x;
            this.panY = this.panStartY = y;
            this.panMoved = false;
            this.mouseX = x;
            this.mouseY = y;
            return;
        }
        if (event.button !== 0) {
            return;
        }
        this.dragX = x;
        this.dragY = y;
        this.mouseX = x;
        this.mouseY = y;
    };

    private onMouseMove = (event: MouseEvent) => {
        if (!this.element) {
            return;
        }
        const [x, y] = getMousePos(this.element, event);
        this.mouseX = x;
        this.mouseY = y;

        if (
            this.isPanning() &&
            Math.hypot(x - this.panStartX, y - this.panStartY) > PAN_CLICK_THRESHOLD
        ) {
            this.panMoved = true;
        }

        if (this.isPointerLock()) {
            this.deltaMouseX -= event.movementX;
            this.deltaMouseY -= event.movementY;
        }
    };

    private onMouseUp = (event: MouseEvent) => {
        if (event.button === 2) {
            if (this.isPanning() && !this.panMoved && this.element) {
                [this.pickX, this.pickY] = getMousePos(this.element, event);
            }
            this.panX = -1;
            this.panY = -1;
            return;
        }
        this.dragX = -1;
        this.dragY = -1;
    };

    private onMouseLeave = (event: MouseEvent) => {
        this.resetMouse();
    };

    private onTouchStart = (event: TouchEvent) => {
        event.preventDefault();
        this.startTouchGesture(event.touches);
    };

    private onTouchMove = (event: TouchEvent) => {
        event.preventDefault();
        if (!this.element) {
            return;
        }
        const touches = event.touches;
        if (touches.length >= 2) {
            [this.mouseX, this.mouseY] = getTouchMidpoint(this.element, touches);
            const distance = getTouchDistance(touches);
            if (this.pinchDistance !== -1) {
                // Spreading the fingers zooms in, as scrolling the wheel away from you does.
                this.wheelDelta += Math.log(this.pinchDistance / distance) * PINCH_WHEEL_PIXELS;
            }
            this.pinchDistance = distance;
        } else if (touches.length === 1) {
            [this.mouseX, this.mouseY] = getMousePos(this.element, touches[0]);
        }
    };

    private onTouchEnd = (event: TouchEvent) => {
        // Carry on with the fingers still down, from where they are, so the camera doesn't jump.
        this.startTouchGesture(event.touches);
    };

    private startTouchGesture(touches: TouchList) {
        this.dragX = -1;
        this.dragY = -1;
        this.panX = -1;
        this.panY = -1;
        this.pinchDistance = -1;
        if (!this.element || touches.length === 0) {
            return;
        }
        if (touches.length === 1) {
            [this.mouseX, this.mouseY] = getMousePos(this.element, touches[0]);
            this.dragX = this.mouseX;
            this.dragY = this.mouseY;
        } else {
            [this.mouseX, this.mouseY] = getTouchMidpoint(this.element, touches);
            this.panX = this.mouseX;
            this.panY = this.mouseY;
            this.panMoved = true;
            this.pinchDistance = getTouchDistance(touches);
        }
    }

    private onContextMenu = (event: MouseEvent) => {
        // The menu opens on right button release instead (see onMouseUp), so a drag can pan.
        event.preventDefault();
    };

    onPositionJoystickMove = (event: IJoystickUpdateEvent) => {
        this.positionJoystickEvent = event;
    };

    onPositionJoystickStop = (event: IJoystickUpdateEvent) => {
        this.positionJoystickEvent = undefined;
    };

    onCameraJoystickMove = (event: IJoystickUpdateEvent) => {
        this.cameraJoystickEvent = event;
    };

    onCameraJoystickStop = (event: IJoystickUpdateEvent) => {
        this.cameraJoystickEvent = undefined;
    };

    private onFocusOut = () => {
        console.log("Focus lost");
        this.keys.clear();
        this.resetMouse();
    };

    resetMouse() {
        this.mouseX = -1;
        this.mouseY = -1;
        this.dragX = -1;
        this.dragY = -1;
        this.panX = -1;
        this.panY = -1;
    }

    onFrameEnd() {
        for (const key of this.keys.keys()) {
            this.keys.set(key, false);
        }
        if (this.isDragging()) {
            this.dragX = this.mouseX;
            this.dragY = this.mouseY;
        }
        if (this.isPanning() && this.panMoved) {
            this.panX = this.mouseX;
            this.panY = this.mouseY;
        }
        this.deltaMouseX = 0;
        this.deltaMouseY = 0;
        this.pickX = -1;
        this.pickY = -1;
        this.lastMouseX = this.mouseX;
        this.lastMouseY = this.mouseY;
    }
}
