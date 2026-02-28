function requiredElement(id) {
    const element = document.getElementById(id);
    if (!element) {
        throw new Error(`Missing required element: #${id}`);
    }
    return element;
}
export class AppUI {
    hostPanel = requiredElement("hostPanel");
    roleBanner = requiredElement("roleBanner");
    reconnectBanner = requiredElement("reconnectBanner");
    connectionFlag = requiredElement("connectionFlag");
    controlFlag = requiredElement("controlFlag");
    cameraFlag = requiredElement("cameraFlag");
    createRoomButton = requiredElement("createRoomBtn");
    enableCameraButton = requiredElement("enableCameraBtn");
    joinRoomInput = requiredElement("joinRoomInput");
    joinRoomButton = requiredElement("joinRoomBtn");
    startShareButton = requiredElement("startShareBtn");
    roomCodeValue = requiredElement("roomCodeValue");
    screenVideo = requiredElement("screenVideo");
    cameraVideo = requiredElement("cameraVideo");
    toast = requiredElement("toast");
    cameraModal = requiredElement("cameraModal");
    allowCameraButton = requiredElement("allowCameraBtn");
    denyCameraButton = requiredElement("denyCameraBtn");
    toastTimerId;
    cameraModalResolver = null;
    cameraModalPromise = null;
    constructor() {
        this.cameraModal.classList.add("hidden");
        this.cameraModalResolver = null;
        this.cameraModalPromise = null;
        this.allowCameraButton.addEventListener("click", () => {
            this.resolveCameraRequest(true);
        });
        this.denyCameraButton.addEventListener("click", () => {
            this.resolveCameraRequest(false);
        });
    }
    getScreenVideoElement() {
        return this.screenVideo;
    }
    bindCreateRoom(handler) {
        this.createRoomButton.addEventListener("click", handler);
    }
    bindJoinRoom(handler) {
        const triggerJoin = () => {
            const roomId = this.joinRoomInput.value.trim();
            if (roomId.length === 0) {
                this.showToast("Enter a 6-digit room code.", "error");
                return;
            }
            handler(roomId);
        };
        this.joinRoomButton.addEventListener("click", triggerJoin);
        this.joinRoomInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                triggerJoin();
            }
        });
    }
    bindStartShare(handler) {
        this.startShareButton.addEventListener("click", handler);
    }
    bindEnableCamera(handler) {
        this.enableCameraButton.addEventListener("click", handler);
    }
    async requestCameraApproval() {
        if (this.cameraModalPromise) {
            return this.cameraModalPromise;
        }
        this.cameraModal.classList.remove("hidden");
        this.cameraModalPromise = new Promise((resolve) => {
            this.cameraModalResolver = resolve;
        });
        return this.cameraModalPromise;
    }
    setJoinInputValue(roomId) {
        this.joinRoomInput.value = roomId;
    }
    setRole(role) {
        this.hostPanel.classList.toggle("hidden", role === "client");
        this.roleBanner.classList.remove("neutral", "host", "client");
        if (role === "host") {
            this.roleBanner.classList.add("host");
            this.roleBanner.textContent = "You are Host (Controller)";
            return;
        }
        if (role === "client") {
            this.roleBanner.classList.add("client");
            this.roleBanner.textContent = "You are Client (Sharing Screen)";
            return;
        }
        this.roleBanner.classList.add("neutral");
        this.roleBanner.textContent = "Not in a room";
    }
    setConnectionState(connected, reconnecting) {
        this.connectionFlag.classList.remove("active", "warning");
        if (connected) {
            this.connectionFlag.textContent = "Connected";
            this.connectionFlag.classList.add("active");
        }
        else if (reconnecting) {
            this.connectionFlag.textContent = "Reconnecting";
            this.connectionFlag.classList.add("warning");
        }
        else {
            this.connectionFlag.textContent = "Disconnected";
        }
        this.reconnectBanner.classList.toggle("hidden", !reconnecting);
    }
    setRoomCode(roomId) {
        this.roomCodeValue.textContent = roomId ?? "-";
    }
    setControlActive(active) {
        this.controlFlag.textContent = active
            ? "Remote Control Active"
            : "Remote Control Inactive";
        this.controlFlag.classList.toggle("active", active);
    }
    setCameraActive(active) {
        this.cameraFlag.textContent = active ? "Camera Active" : "Camera Inactive";
        this.cameraFlag.classList.toggle("active", active);
    }
    setCreateRoomEnabled(enabled) {
        this.createRoomButton.disabled = !enabled;
    }
    setJoinEnabled(enabled) {
        this.joinRoomInput.disabled = !enabled;
        this.joinRoomButton.disabled = !enabled;
    }
    setStartShareEnabled(enabled) {
        this.startShareButton.disabled = !enabled;
    }
    setEnableCameraEnabled(enabled) {
        this.enableCameraButton.disabled = !enabled;
    }
    setScreenStream(stream) {
        this.screenVideo.srcObject = stream;
        if (stream) {
            void this.screenVideo.play().catch(() => undefined);
        }
    }
    setCameraStream(stream) {
        this.cameraVideo.srcObject = stream;
        if (stream) {
            void this.cameraVideo.play().catch(() => undefined);
        }
    }
    closeCameraModal() {
        if (this.cameraModalResolver) {
            this.resolveCameraRequest(false);
        }
        this.cameraModalPromise = null;
        this.cameraModalResolver = null;
        this.cameraModal.classList.add("hidden");
    }
    showToast(message, tone = "info") {
        this.toast.textContent = message;
        this.toast.classList.remove("success", "error");
        if (tone === "success") {
            this.toast.classList.add("success");
        }
        if (tone === "error") {
            this.toast.classList.add("error");
        }
        this.toast.classList.add("visible");
        if (this.toastTimerId) {
            window.clearTimeout(this.toastTimerId);
        }
        this.toastTimerId = window.setTimeout(() => {
            this.toast.classList.remove("visible");
        }, 2600);
    }
    resolveCameraRequest(allowed) {
        if (!this.cameraModalResolver) {
            return;
        }
        const resolver = this.cameraModalResolver;
        this.cameraModalResolver = null;
        this.cameraModalPromise = null;
        this.cameraModal.classList.add("hidden");
        resolver(allowed);
    }
}
