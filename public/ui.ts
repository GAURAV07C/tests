export type AppRole = "host" | "client" | null;

type ToastTone = "info" | "success" | "error";

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);

  if (!element) {
    throw new Error(`Missing required element: #${id}`);
  }

  return element as T;
}

export class AppUI {
  private readonly hostPanel = requiredElement<HTMLElement>("hostPanel");

  private readonly roleBanner = requiredElement<HTMLDivElement>("roleBanner");
  private readonly reconnectBanner = requiredElement<HTMLDivElement>(
    "reconnectBanner",
  );

  private readonly connectionFlag = requiredElement<HTMLSpanElement>(
    "connectionFlag",
  );
  private readonly controlFlag = requiredElement<HTMLSpanElement>("controlFlag");
  private readonly cameraFlag = requiredElement<HTMLSpanElement>("cameraFlag");

  private readonly createRoomButton = requiredElement<HTMLButtonElement>(
    "createRoomBtn",
  );
  private readonly enableCameraButton = requiredElement<HTMLButtonElement>(
    "enableCameraBtn",
  );
  private readonly remoteToggleCameraButton = requiredElement<HTMLButtonElement>(
    "remoteToggleCameraBtn",
  );
  private readonly remoteToggleMicButton = requiredElement<HTMLButtonElement>(
    "remoteToggleMicBtn",
  );

  private readonly joinRoomInput = requiredElement<HTMLInputElement>(
    "joinRoomInput",
  );
  private readonly joinRoomButton = requiredElement<HTMLButtonElement>(
    "joinRoomBtn",
  );
  private readonly startShareButton = requiredElement<HTMLButtonElement>(
    "startShareBtn",
  );
  private readonly toggleCameraButton = requiredElement<HTMLButtonElement>(
    "toggleCameraBtn",
  );
  private readonly toggleMicButton = requiredElement<HTMLButtonElement>(
    "toggleMicBtn",
  );

  private readonly roomCodeValue = requiredElement<HTMLSpanElement>("roomCodeValue");

  private readonly screenVideo = requiredElement<HTMLVideoElement>("screenVideo");
  private readonly cameraVideo = requiredElement<HTMLVideoElement>("cameraVideo");

  private readonly toast = requiredElement<HTMLDivElement>("toast");

  private readonly cameraModal = requiredElement<HTMLDivElement>("cameraModal");
  private readonly allowCameraButton = requiredElement<HTMLButtonElement>(
    "allowCameraBtn",
  );
  private readonly denyCameraButton = requiredElement<HTMLButtonElement>(
    "denyCameraBtn",
  );

  private toastTimerId: number | undefined;
  private cameraPlaybackHintShown = false;
  private cameraModalResolver: ((allowed: boolean) => void) | null = null;
  private cameraModalPromise: Promise<boolean> | null = null;

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

  public getScreenVideoElement(): HTMLVideoElement {
    return this.screenVideo;
  }

  public bindCreateRoom(handler: () => void): void {
    this.createRoomButton.addEventListener("click", handler);
  }

  public bindJoinRoom(handler: (roomId: string) => void): void {
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

  public bindStartShare(handler: () => void): void {
    this.startShareButton.addEventListener("click", handler);
  }

  public bindEnableCamera(handler: () => void): void {
    this.enableCameraButton.addEventListener("click", handler);
  }

  public bindRemoteToggleCamera(handler: () => void): void {
    this.remoteToggleCameraButton.addEventListener("click", handler);
  }

  public bindRemoteToggleMic(handler: () => void): void {
    this.remoteToggleMicButton.addEventListener("click", handler);
  }

  public bindToggleCamera(handler: () => void): void {
    this.toggleCameraButton.addEventListener("click", handler);
  }

  public bindToggleMic(handler: () => void): void {
    this.toggleMicButton.addEventListener("click", handler);
  }

  public async requestCameraApproval(): Promise<boolean> {
    if (this.cameraModalPromise) {
      return this.cameraModalPromise;
    }

    this.cameraModal.classList.remove("hidden");

    this.cameraModalPromise = new Promise<boolean>((resolve) => {
      this.cameraModalResolver = resolve;
    });

    return this.cameraModalPromise;
  }

  public setJoinInputValue(roomId: string): void {
    this.joinRoomInput.value = roomId;
  }

  public setRole(role: AppRole): void {
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

  public setConnectionState(connected: boolean, reconnecting: boolean): void {
    this.connectionFlag.classList.remove("active", "warning");

    if (connected) {
      this.connectionFlag.textContent = "Connected";
      this.connectionFlag.classList.add("active");
    } else if (reconnecting) {
      this.connectionFlag.textContent = "Reconnecting";
      this.connectionFlag.classList.add("warning");
    } else {
      this.connectionFlag.textContent = "Disconnected";
    }

    this.reconnectBanner.classList.toggle("hidden", !reconnecting);
  }

  public setRoomCode(roomId: string | null): void {
    this.roomCodeValue.textContent = roomId ?? "-";
  }

  public setControlActive(active: boolean): void {
    this.controlFlag.textContent = active
      ? "Remote Control Active"
      : "Remote Control Inactive";
    this.controlFlag.classList.toggle("active", active);
  }

  public setCameraActive(active: boolean): void {
    this.cameraFlag.textContent = active
      ? "Camera + Voice Active"
      : "Camera + Voice Inactive";
    this.cameraFlag.classList.toggle("active", active);
  }

  public setCreateRoomEnabled(enabled: boolean): void {
    this.createRoomButton.disabled = !enabled;
  }

  public setJoinEnabled(enabled: boolean): void {
    this.joinRoomInput.disabled = !enabled;
    this.joinRoomButton.disabled = !enabled;
  }

  public setStartShareEnabled(enabled: boolean): void {
    this.startShareButton.disabled = !enabled;
  }

  public setEnableCameraEnabled(enabled: boolean): void {
    this.enableCameraButton.disabled = !enabled;
  }

  public setRemoteMediaControlEnabled(enabled: boolean): void {
    this.remoteToggleCameraButton.disabled = !enabled;
    this.remoteToggleMicButton.disabled = !enabled;
  }

  public setToggleCameraState(available: boolean, enabled: boolean): void {
    this.toggleCameraButton.disabled = !available;
    this.toggleCameraButton.textContent = enabled
      ? "Turn Camera Off"
      : "Turn Camera On";
  }

  public setToggleMicState(available: boolean, enabled: boolean): void {
    this.toggleMicButton.disabled = !available;
    this.toggleMicButton.textContent = enabled ? "Mute Mic" : "Unmute Mic";
  }

  public setScreenStream(stream: MediaStream | null): void {
    this.screenVideo.srcObject = stream;

    if (stream) {
      void this.screenVideo.play().catch(() => undefined);
    }
  }

  public setCameraStream(stream: MediaStream | null): void {
    this.cameraVideo.srcObject = stream;

    if (!stream) {
      this.cameraPlaybackHintShown = false;
      return;
    }

    this.cameraVideo.muted = false;
    this.cameraVideo.volume = 1;

    void this.cameraVideo.play().catch(() => {
      if (this.cameraPlaybackHintShown) {
        return;
      }

      this.cameraPlaybackHintShown = true;
      this.showToast("Tap Client Camera panel once to enable voice playback.");
    });
  }

  public closeCameraModal(): void {
    if (this.cameraModalResolver) {
      this.resolveCameraRequest(false);
    }
    this.cameraModalPromise = null;
    this.cameraModalResolver = null;
    this.cameraModal.classList.add("hidden");
  }

  public showToast(message: string, tone: ToastTone = "info"): void {
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

  private resolveCameraRequest(allowed: boolean): void {
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
