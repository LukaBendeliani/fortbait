import Phaser from 'phaser';
import { io, Socket } from 'socket.io-client';
import {
    GAME_CONFIG,
    MessageType,
    PlayerState,
    PlayerStanding,
    GameState,
    InputState,
    WelcomeMessage,
    ItemType,
    GamePhase,
    KillLogEntry,
    EffectType,
    EffectState,
    ItemState,
    ProjectileState,
    ObstacleState,
} from '../shared';

type AutomationWindow = Window & {
    render_game_to_text?: () => string;
    advanceTime?: (ms: number) => Promise<void>;
};

const DEFAULT_INPUT: InputState = { up: false, down: false, left: false, right: false, angle: 0 };
const PLAYER_NAME_STORAGE_KEY = 'fortbait.playerName';
const MAX_PLAYER_NAME_LENGTH = 18;

export class GameScene extends Phaser.Scene {
    private socket: Socket | null = null;
    private playerId = '';
    private isConnected = false;
    private latestGameState: GameState | null = null;
    private latestStandings: PlayerStanding[] = [];

    private playerSprites: Map<string, Phaser.GameObjects.Sprite> = new Map();
    private playerLabels: Map<string, Phaser.GameObjects.Text> = new Map();
    private healthBars: Map<string, Phaser.GameObjects.Graphics> = new Map();
    private itemSprites: Map<string, Phaser.GameObjects.Sprite> = new Map();
    private obstacleRects: Phaser.GameObjects.Rectangle[] = [];

    private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
    private wasd!: { W: Phaser.Input.Keyboard.Key; A: Phaser.Input.Keyboard.Key; S: Phaser.Input.Keyboard.Key; D: Phaser.Input.Keyboard.Key };
    private spaceKey!: Phaser.Input.Keyboard.Key;
    private hKey!: Phaser.Input.Keyboard.Key;
    private fKey!: Phaser.Input.Keyboard.Key;

    private connectionText!: Phaser.GameObjects.Text;
    private controlsText!: Phaser.GameObjects.Text;
    private inventoryText!: Phaser.GameObjects.Text;
    private phaseText!: Phaser.GameObjects.Text;
    private killFeedTexts: Phaser.GameObjects.Text[] = [];
    private recentKillFeed: string[] = [];

    private zoneGraphics!: Phaser.GameObjects.Graphics;
    private projectileGraphics!: Phaser.GameObjects.Graphics;
    private minimapCamera!: Phaser.Cameras.Scene2D.Camera;

    private bloodEmitter!: Phaser.GameObjects.Particles.ParticleEmitter;
    private sparksEmitter!: Phaser.GameObjects.Particles.ParticleEmitter;
    private flashEmitter!: Phaser.GameObjects.Particles.ParticleEmitter;

    private lastInput: InputState = { ...DEFAULT_INPUT };
    private lastHealth = 100;
    private lastLocalSample: { x: number; y: number; t: number } | null = null;
    private localVelocity = { x: 0, y: 0 };
    private readonly minimapSize = 150;

    private hasSubmittedName = false;
    private pendingPlayerName = '';

    private lobbyOverlayEl: HTMLDivElement | null = null;
    private lobbyStatusEl: HTMLDivElement | null = null;
    private nameInputEl: HTMLInputElement | null = null;
    private nameControlsEl: HTMLDivElement | null = null;
    private joinedPlayersListEl: HTMLUListElement | null = null;

    private gameOverOverlayEl: HTMLDivElement | null = null;
    private gameOverTitleEl: HTMLDivElement | null = null;
    private gameOverListEl: HTMLUListElement | null = null;

    private isTextInputFocused(): boolean {
        const active = document.activeElement as HTMLElement | null;
        if (!active) {
            return false;
        }

        const tag = active.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || active.isContentEditable;
    }

    private isLobbyVisible(): boolean {
        return Boolean(this.lobbyOverlayEl && this.lobbyOverlayEl.style.display !== 'none');
    }

    private shouldBlockGameplayHotkeys(): boolean {
        return this.isLobbyVisible() || this.isTextInputFocused();
    }

    constructor() {
        super({ key: 'GameScene' });
    }

    preload() {
        this.load.atlasXML('characters', '/assets/spritesheet_characters.png', '/assets/spritesheet_characters.xml');
        this.load.spritesheet('tiles', '/assets/spritesheet_tiles.png', { frameWidth: 64, frameHeight: 64, spacing: 10 });
        this.load.image('weapon_pistol', '/assets/weapon_pistol.png');
        this.load.image('weapon_rifle', '/assets/weapon_rifle.png');
        this.load.image('weapon_shotgun', '/assets/weapon_shotgun.png');
        this.load.image('weapon_sniper', '/assets/weapon_sniper.png');
    }

    create(): void {
        const { width, height } = this.scale;

        this.cameras.main.setBounds(0, 0, GAME_CONFIG.WORLD_WIDTH, GAME_CONFIG.WORLD_HEIGHT);
        this.minimapCamera = this.cameras.add(width - this.minimapSize - 10, 10, this.minimapSize, this.minimapSize)
            .setZoom(this.minimapSize / GAME_CONFIG.WORLD_WIDTH)
            .setName('minimap')
            .setBackgroundColor(0x000000)
            .setAlpha(0.82)
            .setBounds(0, 0, GAME_CONFIG.WORLD_WIDTH, GAME_CONFIG.WORLD_HEIGHT);

        this.createBackground();

        this.connectionText = this.add.text(width / 2, height / 2, 'Connecting...', { fontSize: '24px', color: '#4ecdc4' })
            .setOrigin(0.5)
            .setScrollFactor(0)
            .setDepth(11);

        this.controlsText = this.add.text(10, height - 10, 'Move WASD/Arrows | Aim Mouse | Shoot Click/Space | Medkit H | Fullscreen F', {
            fontSize: '13px',
            color: '#d3f8e2',
            backgroundColor: '#00000055',
            padding: { x: 8, y: 4 },
        })
            .setOrigin(0, 1)
            .setScrollFactor(0)
            .setDepth(10);

        this.inventoryText = this.add.text(10, 10, '', {
            fontSize: '16px',
            color: '#ffffff',
            backgroundColor: '#00000088',
            padding: { x: 8, y: 4 },
        })
            .setDepth(10)
            .setScrollFactor(0);

        this.phaseText = this.add.text(width / 2, 50, '', {
            fontSize: '32px',
            color: '#ffffff',
            stroke: '#000000',
            strokeThickness: 4,
        })
            .setOrigin(0.5)
            .setDepth(10)
            .setScrollFactor(0);

        this.projectileGraphics = this.add.graphics();
        this.zoneGraphics = this.add.graphics();
        this.createPixelTexture();

        this.bloodEmitter = this.add.particles(0, 0, 'pixel', {
            color: [0xff0000, 0x880000],
            speed: { min: 50, max: 100 },
            scale: { start: 1, end: 0 },
            lifespan: 400,
            emitting: false,
        });

        this.sparksEmitter = this.add.particles(0, 0, 'pixel', {
            color: [0xffff00, 0xffa500],
            speed: { min: 80, max: 150 },
            scale: { start: 1, end: 0 },
            lifespan: 300,
            emitting: false,
        });

        this.flashEmitter = this.add.particles(0, 0, 'pixel', {
            color: [0xffffff, 0xffff00],
            scale: { start: 2, end: 0 },
            lifespan: 100,
            speed: 20,
            emitting: false,
        });

        this.minimapCamera.ignore([
            this.connectionText,
            this.controlsText,
            this.inventoryText,
            this.phaseText,
            this.bloodEmitter,
            this.sparksEmitter,
            this.flashEmitter,
        ]);

        this.cursors = this.input.keyboard!.createCursorKeys();
        this.wasd = {
            W: this.input.keyboard!.addKey('W'),
            A: this.input.keyboard!.addKey('A'),
            S: this.input.keyboard!.addKey('S'),
            D: this.input.keyboard!.addKey('D'),
        };
        this.spaceKey = this.input.keyboard!.addKey('SPACE');
        this.hKey = this.input.keyboard!.addKey('H');
        this.fKey = this.input.keyboard!.addKey('F', false);

        this.hKey.on('down', () => {
            if (this.socket && this.playerId && this.hasSubmittedName) {
                this.socket.emit(MessageType.USE_ITEM, ItemType.MEDKIT);
            }
        });

        this.fKey.on('down', () => {
            if (this.shouldBlockGameplayHotkeys()) {
                return;
            }
            this.toggleFullscreen();
        });
        this.scale.on(Phaser.Scale.Events.RESIZE, this.handleResize, this);

        this.createLobbyOverlay();
        this.createGameOverOverlay();
        this.updateLobbyOverlay();
        this.updateGameOverOverlay();

        this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
            this.scale.off(Phaser.Scale.Events.RESIZE, this.handleResize, this);
            this.unregisterAutomationHooks();
            this.destroyDomOverlays();
        });

        this.registerAutomationHooks();
        this.connectToServer();
    }

    private createBackground(): void {
        this.add.rectangle(
            GAME_CONFIG.WORLD_WIDTH / 2,
            GAME_CONFIG.WORLD_HEIGHT / 2,
            GAME_CONFIG.WORLD_WIDTH,
            GAME_CONFIG.WORLD_HEIGHT,
            0x2eaa6f
        ).setDepth(-5);

        this.add.rectangle(
            GAME_CONFIG.WORLD_WIDTH / 2,
            GAME_CONFIG.WORLD_HEIGHT / 2,
            GAME_CONFIG.WORLD_WIDTH,
            GAME_CONFIG.WORLD_HEIGHT,
            0x173f35,
            0.08
        ).setDepth(-4);
    }

    private createPixelTexture() {
        if (this.textures.exists('pixel')) {
            return;
        }

        const graphics = this.add.graphics();
        graphics.fillStyle(0xffffff);
        graphics.fillRect(0, 0, 4, 4);
        graphics.generateTexture('pixel', 4, 4);
        graphics.destroy();
    }

    private sanitizePlayerName(input: string): string {
        const compact = input.trim().replace(/\s+/g, ' ');
        return compact.slice(0, MAX_PLAYER_NAME_LENGTH);
    }

    private createLobbyOverlay(): void {
        const wrapper = document.createElement('div');
        wrapper.style.position = 'fixed';
        wrapper.style.inset = '0';
        wrapper.style.display = 'flex';
        wrapper.style.alignItems = 'center';
        wrapper.style.justifyContent = 'center';
        wrapper.style.pointerEvents = 'none';
        wrapper.style.zIndex = '40';

        const panel = document.createElement('div');
        panel.style.width = 'min(520px, 90vw)';
        panel.style.background = 'rgba(10, 28, 21, 0.92)';
        panel.style.border = '1px solid rgba(136, 216, 176, 0.45)';
        panel.style.borderRadius = '12px';
        panel.style.padding = '18px';
        panel.style.color = '#e6fff4';
        panel.style.fontFamily = 'monospace';
        panel.style.pointerEvents = 'auto';
        panel.style.boxShadow = '0 20px 45px rgba(0, 0, 0, 0.35)';

        const title = document.createElement('div');
        title.textContent = 'FortBait Lobby';
        title.style.fontSize = '24px';
        title.style.fontWeight = '700';
        title.style.marginBottom = '8px';
        panel.appendChild(title);

        const status = document.createElement('div');
        status.style.fontSize = '14px';
        status.style.opacity = '0.95';
        status.style.marginBottom = '12px';
        panel.appendChild(status);
        this.lobbyStatusEl = status;

        const controlsRow = document.createElement('div');
        controlsRow.style.display = 'flex';
        controlsRow.style.gap = '8px';
        controlsRow.style.marginBottom = '14px';

        const input = document.createElement('input');
        input.type = 'text';
        input.maxLength = MAX_PLAYER_NAME_LENGTH;
        input.placeholder = 'Enter your name';
        input.style.flex = '1';
        input.style.padding = '10px';
        input.style.borderRadius = '8px';
        input.style.border = '1px solid rgba(136, 216, 176, 0.5)';
        input.style.background = '#0f2f25';
        input.style.color = '#e6fff4';
        input.style.fontFamily = 'monospace';
        input.style.fontSize = '14px';
        const savedName = this.sanitizePlayerName(window.localStorage.getItem(PLAYER_NAME_STORAGE_KEY) || '');
        input.value = savedName;
        this.nameInputEl = input;

        const submit = document.createElement('button');
        submit.type = 'button';
        submit.textContent = 'Join';
        submit.style.padding = '10px 14px';
        submit.style.border = 'none';
        submit.style.borderRadius = '8px';
        submit.style.background = '#43d18a';
        submit.style.color = '#062012';
        submit.style.fontWeight = '700';
        submit.style.cursor = 'pointer';

        submit.addEventListener('click', () => this.submitPlayerName());
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                this.submitPlayerName();
            }
        });
        input.addEventListener('focus', () => {
            if (this.input.keyboard) {
                this.input.keyboard.enabled = false;
            }
        });
        input.addEventListener('blur', () => {
            if (this.input.keyboard) {
                this.input.keyboard.enabled = true;
            }
        });

        controlsRow.appendChild(input);
        controlsRow.appendChild(submit);
        panel.appendChild(controlsRow);
        this.nameControlsEl = controlsRow;

        const playersTitle = document.createElement('div');
        playersTitle.textContent = 'Joined Players';
        playersTitle.style.fontSize = '13px';
        playersTitle.style.opacity = '0.8';
        playersTitle.style.marginBottom = '8px';
        panel.appendChild(playersTitle);

        const playersList = document.createElement('ul');
        playersList.style.margin = '0';
        playersList.style.padding = '0 0 0 18px';
        playersList.style.maxHeight = '180px';
        playersList.style.overflowY = 'auto';
        playersList.style.fontSize = '14px';
        playersList.style.lineHeight = '1.5';
        panel.appendChild(playersList);
        this.joinedPlayersListEl = playersList;

        wrapper.appendChild(panel);
        document.body.appendChild(wrapper);
        this.lobbyOverlayEl = wrapper;
    }

    private createGameOverOverlay(): void {
        const wrapper = document.createElement('div');
        wrapper.style.position = 'fixed';
        wrapper.style.inset = '0';
        wrapper.style.display = 'none';
        wrapper.style.alignItems = 'center';
        wrapper.style.justifyContent = 'center';
        wrapper.style.pointerEvents = 'none';
        wrapper.style.zIndex = '45';

        const panel = document.createElement('div');
        panel.style.width = 'min(540px, 92vw)';
        panel.style.background = 'rgba(19, 20, 32, 0.92)';
        panel.style.border = '1px solid rgba(229, 212, 160, 0.55)';
        panel.style.borderRadius = '12px';
        panel.style.padding = '18px';
        panel.style.color = '#f3f0db';
        panel.style.fontFamily = 'monospace';
        panel.style.pointerEvents = 'auto';
        panel.style.boxShadow = '0 24px 46px rgba(0, 0, 0, 0.38)';

        const title = document.createElement('div');
        title.style.fontSize = '24px';
        title.style.fontWeight = '700';
        title.style.marginBottom = '12px';
        panel.appendChild(title);
        this.gameOverTitleEl = title;

        const subtitle = document.createElement('div');
        subtitle.textContent = 'Players and kill count';
        subtitle.style.fontSize = '13px';
        subtitle.style.opacity = '0.85';
        subtitle.style.marginBottom = '10px';
        panel.appendChild(subtitle);

        const list = document.createElement('ul');
        list.style.margin = '0';
        list.style.padding = '0 0 0 18px';
        list.style.fontSize = '15px';
        list.style.lineHeight = '1.65';
        list.style.maxHeight = '220px';
        list.style.overflowY = 'auto';
        panel.appendChild(list);
        this.gameOverListEl = list;

        wrapper.appendChild(panel);
        document.body.appendChild(wrapper);
        this.gameOverOverlayEl = wrapper;
    }

    private destroyDomOverlays(): void {
        this.lobbyOverlayEl?.remove();
        this.gameOverOverlayEl?.remove();
        this.lobbyOverlayEl = null;
        this.gameOverOverlayEl = null;
        this.lobbyStatusEl = null;
        this.nameInputEl = null;
        this.nameControlsEl = null;
        this.joinedPlayersListEl = null;
        this.gameOverTitleEl = null;
        this.gameOverListEl = null;
        if (this.input.keyboard) {
            this.input.keyboard.enabled = true;
        }
    }

    private submitPlayerName(): void {
        if (!this.nameInputEl) {
            return;
        }

        const sanitized = this.sanitizePlayerName(this.nameInputEl.value);
        if (!sanitized) {
            if (this.lobbyStatusEl) {
                this.lobbyStatusEl.textContent = 'Enter a valid name first.';
            }
            return;
        }

        this.pendingPlayerName = sanitized;
        this.hasSubmittedName = true;
        window.localStorage.setItem(PLAYER_NAME_STORAGE_KEY, sanitized);
        if (this.input.keyboard) {
            this.input.keyboard.enabled = true;
        }

        if (this.socket && this.socket.connected) {
            this.socket.emit(MessageType.SET_NAME, sanitized);
        }

        this.updateLobbyOverlay(this.latestGameState);
    }

    private toggleFullscreen(): void {
        if (this.scale.isFullscreen) {
            this.scale.stopFullscreen();
            return;
        }
        this.scale.startFullscreen();
    }

    private handleResize(gameSize: Phaser.Structs.Size): void {
        this.minimapCamera.setViewport(gameSize.width - this.minimapSize - 10, 10, this.minimapSize, this.minimapSize);
        this.connectionText.setPosition(gameSize.width / 2, gameSize.height / 2);
        this.phaseText.setPosition(gameSize.width / 2, 50);
        this.controlsText.setPosition(10, gameSize.height - 10);
        this.killFeedTexts.forEach((entry, index) => {
            entry.setPosition(gameSize.width - 170, 170 + index * 20);
        });
    }

    private updateLobbyOverlay(state: GameState | null = this.latestGameState): void {
        if (!this.lobbyOverlayEl || !this.lobbyStatusEl || !this.joinedPlayersListEl) {
            return;
        }

        const phase = state?.phase;
        const show = !this.hasSubmittedName || !this.isConnected || phase === GamePhase.LOBBY || phase === GamePhase.COUNTDOWN;
        this.lobbyOverlayEl.style.display = show ? 'flex' : 'none';

        if (this.nameControlsEl) {
            this.nameControlsEl.style.display = this.hasSubmittedName ? 'none' : 'flex';
            if (this.hasSubmittedName && this.input.keyboard) {
                this.input.keyboard.enabled = true;
            }
        }

        if (!this.isConnected) {
            this.lobbyStatusEl.textContent = 'Connecting to game server...';
        } else if (!this.hasSubmittedName) {
            this.lobbyStatusEl.textContent = 'Enter your name to join the lobby.';
        } else if (phase === GamePhase.COUNTDOWN) {
            this.lobbyStatusEl.textContent = `Starting in ${Math.max(0, state?.phaseTimer ?? 0)}...`;
        } else if (phase === GamePhase.LOBBY) {
            const joinedCount = state?.standings.length ?? 0;
            this.lobbyStatusEl.textContent = `Waiting for players (${joinedCount}/${GAME_CONFIG.LOBBY_MIN_PLAYERS} minimum).`;
        } else if (phase === GamePhase.IN_GAME) {
            this.lobbyStatusEl.textContent = 'Match in progress.';
        } else {
            this.lobbyStatusEl.textContent = 'Connected.';
        }

        const standings = state?.standings ?? this.latestStandings;
        this.joinedPlayersListEl.innerHTML = '';
        if (!standings.length) {
            const placeholder = document.createElement('li');
            placeholder.textContent = 'No players joined yet.';
            this.joinedPlayersListEl.appendChild(placeholder);
            return;
        }

        standings.forEach((entry) => {
            const line = document.createElement('li');
            const isSelf = entry.id === this.playerId;
            line.textContent = isSelf ? `${entry.name} (You)` : entry.name;
            this.joinedPlayersListEl?.appendChild(line);
        });
    }

    private updateGameOverOverlay(state: GameState | null = this.latestGameState): void {
        if (!this.gameOverOverlayEl || !this.gameOverTitleEl || !this.gameOverListEl) {
            return;
        }

        const show = Boolean(state && state.phase === GamePhase.GAME_OVER && !this.isLobbyVisible());
        this.gameOverOverlayEl.style.display = show ? 'flex' : 'none';
        if (!show || !state) {
            return;
        }

        const winnerName = state.winnerId ? this.getPlayerName(state.winnerId) : 'No winner';
        this.gameOverTitleEl.textContent = `Game Over - ${winnerName}`;

        this.gameOverListEl.innerHTML = '';
        const standings = state.standings.length ? state.standings : this.latestStandings;
        standings.forEach((entry, index) => {
            const line = document.createElement('li');
            const suffix = entry.id === this.playerId ? ' (You)' : '';
            line.textContent = `${index + 1}. ${entry.name}${suffix} - ${entry.kills} kill${entry.kills === 1 ? '' : 's'}`;
            this.gameOverListEl?.appendChild(line);
        });
    }

    private getServerConnectionConfig(): { serverUrl: string; serverPort: number } {
        const envUrl = (import.meta.env.VITE_SERVER_URL || '').trim();
        const envPort = Number.parseInt(import.meta.env.VITE_SERVER_PORT || '', 10);
        const serverUrl = envUrl || window.location.hostname;
        const serverPort = Number.isFinite(envPort) ? envPort : 9208;
        return { serverUrl, serverPort };
    }

    private buildSocketUrl(serverUrl: string, serverPort: number): string {
        if (serverUrl.startsWith('http://') || serverUrl.startsWith('https://')) {
            const parsed = new URL(serverUrl);
            if (!parsed.port) {
                const isDefaultHttps = parsed.protocol === 'https:' && serverPort === 443;
                const isDefaultHttp = parsed.protocol === 'http:' && serverPort === 80;
                if (!isDefaultHttps && !isDefaultHttp) {
                    parsed.port = String(serverPort);
                }
            }
            return parsed.toString();
        }

        const protocol = window.location.protocol;
        const isDefaultHttps = protocol === 'https:' && serverPort === 443;
        const isDefaultHttp = protocol === 'http:' && serverPort === 80;
        const includePort = !isDefaultHttps && !isDefaultHttp;
        return `${protocol}//${serverUrl}${includePort ? `:${serverPort}` : ''}`;
    }

    private connectToServer(): void {
        const { serverUrl, serverPort } = this.getServerConnectionConfig();
        const socketUrl = this.buildSocketUrl(serverUrl, serverPort);

        this.connectionText.setText('Connecting...').setVisible(true);
        this.socket = io(socketUrl, {
            autoConnect: false,
            transports: ['websocket', 'polling'],
        });

        this.socket.on('connect', () => {
            this.isConnected = true;
            this.connectionText.setVisible(false);
            if (this.hasSubmittedName && this.pendingPlayerName) {
                this.socket?.emit(MessageType.SET_NAME, this.pendingPlayerName);
            }
            this.updateLobbyOverlay(this.latestGameState);
        });

        this.socket.on('connect_error', () => {
            this.isConnected = false;
            this.connectionText.setText('Connection Failed').setVisible(true);
            this.updateLobbyOverlay(this.latestGameState);
        });

        this.socket.on(MessageType.WELCOME, (data: unknown) => {
            const welcome = data as WelcomeMessage;
            this.playerId = welcome.playerId;
            this.latestGameState = welcome.gameState;
            this.latestStandings = welcome.gameState.standings;
            this.updateObstacles(welcome.gameState.obstacles);
            Object.values(welcome.gameState.players).forEach((player) => this.createPlayerSprite(player));
            if (this.hasSubmittedName && this.pendingPlayerName) {
                this.socket?.emit(MessageType.SET_NAME, this.pendingPlayerName);
            }
            this.updateLobbyOverlay(this.latestGameState);
            this.updateGameOverOverlay(this.latestGameState);
        });

        this.socket.on(MessageType.PLAYER_JOIN, (data: unknown) => this.createPlayerSprite(data as PlayerState));
        this.socket.on(MessageType.PLAYER_LEAVE, (data: unknown) => this.removePlayerSprite((data as { id: string }).id));
        this.socket.on(MessageType.GAME_STATE, (data: unknown) => this.updateGameState(data as GameState));
        this.socket.on(MessageType.KILL_LOG, (data: unknown) => this.addKillLog(data as KillLogEntry));
        this.socket.on(MessageType.EFFECT_EVENT, (data: unknown) => this.triggerEffect(data as EffectState));

        this.socket.on('disconnect', () => {
            this.isConnected = false;
            this.latestGameState = null;
            this.connectionText.setText('Disconnected').setVisible(true);
            this.updateLobbyOverlay(this.latestGameState);
            this.updateGameOverOverlay(this.latestGameState);
        });

        this.socket.connect();
    }

    private getPlayerName(id: string): string {
        if (id === 'ZONE') {
            return 'ZONE';
        }
        return this.latestGameState?.players[id]?.name || id.slice(0, 4);
    }

    private getLabelText(player: PlayerState): string {
        return player.id === this.playerId ? `${player.name} (YOU)` : player.name;
    }

    private addKillLog(entry: KillLogEntry) {
        const { width } = this.scale;
        const killerName = entry.killerId === this.playerId ? 'YOU' : this.getPlayerName(entry.killerId);
        const victimName = entry.victimId === this.playerId ? 'YOU' : this.getPlayerName(entry.victimId);
        const feedLine = `${killerName} [${entry.weapon.toUpperCase()}] ${victimName}`;

        this.recentKillFeed.unshift(feedLine);
        this.recentKillFeed = this.recentKillFeed.slice(0, 8);

        const text = this.add.text(width - 170, 170 + this.killFeedTexts.length * 20, feedLine, {
            fontSize: '14px',
            color: entry.victimId === this.playerId ? '#ff4d4d' : (entry.killerId === this.playerId ? '#4dff4d' : '#ffffff'),
            backgroundColor: '#00000044',
            padding: { x: 5, y: 2 },
        })
            .setScrollFactor(0)
            .setDepth(10)
            .setOrigin(1, 0);

        this.minimapCamera.ignore(text);
        this.killFeedTexts.push(text);

        this.time.delayedCall(5000, () => {
            text.destroy();
            this.killFeedTexts = this.killFeedTexts.filter((feedEntry) => feedEntry !== text);
            this.killFeedTexts.forEach((feedEntry, i) => {
                feedEntry.setY(170 + i * 20);
            });
        });
    }

    private shoot(targetX: number, targetY: number): void {
        if (!this.socket || !this.playerId || !this.hasSubmittedName) {
            return;
        }

        const sprite = this.playerSprites.get(this.playerId);
        if (!sprite || sprite.alpha !== 1) {
            return;
        }

        const worldPoint = this.cameras.main.getWorldPoint(targetX, targetY);
        this.socket.emit(MessageType.SHOOT, Phaser.Math.Angle.Between(sprite.x, sprite.y, worldPoint.x, worldPoint.y));
    }

    private triggerEffect(effect: EffectState) {
        if (effect.type === EffectType.BLOOD) {
            this.bloodEmitter.explode(10, effect.x, effect.y);
            return;
        }

        if (effect.type === EffectType.SPARKS) {
            this.sparksEmitter.explode(8, effect.x, effect.y);
            return;
        }

        this.flashEmitter.explode(5, effect.x, effect.y);
        const shooter = Array.from(this.playerSprites.values()).find((sprite) =>
            Phaser.Math.Distance.Between(sprite.x, sprite.y, effect.x, effect.y) < 5
        );
        if (shooter) {
            this.tweens.add({
                targets: shooter,
                scale: 0.8,
                duration: 50,
                yoyo: true,
            });
        }
    }

    private getSkinForPlayer(id: string): string {
        const skins = [
            'manBlue_gun.png',
            'manBrown_gun.png',
            'manOld_gun.png',
            'robot1_gun.png',
            'soldier1_gun.png',
            'survivor1_gun.png',
            'womanGreen_gun.png',
        ];
        let hash = 0;
        for (let i = 0; i < id.length; i++) {
            hash = id.charCodeAt(i) + ((hash << 5) - hash);
        }
        return skins[Math.abs(hash) % skins.length];
    }

    private createPlayerSprite(player: PlayerState): void {
        if (this.playerSprites.has(player.id)) {
            return;
        }

        const skin = this.getSkinForPlayer(player.id);
        const sprite = this.add.sprite(player.x, player.y, 'characters', skin).setOrigin(0.5);
        const label = this.add.text(player.x, player.y - 35, this.getLabelText(player), { fontSize: '12px' }).setOrigin(0.5);
        const healthBar = this.add.graphics();

        this.playerSprites.set(player.id, sprite);
        this.playerLabels.set(player.id, label);
        this.healthBars.set(player.id, healthBar);

        if (player.id === this.playerId) {
            this.cameras.main.startFollow(sprite, true, 0.1, 0.1);
            this.minimapCamera.startFollow(sprite, true, 0.1, 0.1);
        }
    }

    private removePlayerSprite(id: string): void {
        this.playerSprites.get(id)?.destroy();
        this.playerLabels.get(id)?.destroy();
        this.healthBars.get(id)?.destroy();
        this.playerSprites.delete(id);
        this.playerLabels.delete(id);
        this.healthBars.delete(id);
    }

    private updateObstacles(obstacles: ObstacleState[]) {
        this.obstacleRects.forEach((rect) => rect.destroy());
        this.obstacleRects = [];
        obstacles.forEach((obstacle) => {
            const rect = this.add.rectangle(
                obstacle.x + obstacle.width / 2,
                obstacle.y + obstacle.height / 2,
                obstacle.width,
                obstacle.height,
                0xc67d4c
            );
            rect.setStrokeStyle(2, 0x8f552f, 0.95);
            this.obstacleRects.push(rect);
        });
    }

    private updateGameState(state: GameState): void {
        this.latestGameState = state;
        this.latestStandings = state.standings;

        if (state.phase === GamePhase.LOBBY) {
            this.phaseText.setText('WAITING FOR PLAYERS...');
        } else if (state.phase === GamePhase.COUNTDOWN) {
            this.phaseText.setText(`STARTING IN ${Math.max(0, state.phaseTimer)}`);
        } else if (state.phase === GamePhase.GAME_OVER) {
            const winner = state.winnerId ? this.getPlayerName(state.winnerId) : 'NONE';
            this.phaseText.setText(`WINNER: ${state.winnerId === this.playerId ? 'YOU!' : winner}`);
        } else {
            this.phaseText.setText('');
        }

        this.zoneGraphics
            .clear()
            .lineStyle(4, 0xff0000, 0.5)
            .strokeCircle(state.zone.x, state.zone.y, state.zone.radius);

        Object.values(state.players).forEach((player) => {
            if (!this.playerSprites.has(player.id)) {
                this.createPlayerSprite(player);
            }
        });

        Array.from(this.playerSprites.keys()).forEach((id) => {
            if (!state.players[id]) {
                this.removePlayerSprite(id);
            }
        });

        const activeItemIds = new Set<string>();
        state.items.forEach((item: ItemState) => {
            activeItemIds.add(item.id);

            let sprite = this.itemSprites.get(item.id);
            if (!sprite) {
                let texture = 'weapon_pistol';
                if (item.type === ItemType.MEDKIT || item.type === ItemType.AMMO) {
                    texture = 'tiles';
                }

                sprite = this.add.sprite(item.x, item.y, texture).setOrigin(0.5).setScale(0.5);
                if (item.type === ItemType.MEDKIT) {
                    sprite.setFrame(268);
                } else if (item.type === ItemType.AMMO) {
                    sprite.setFrame(214);
                } else if (item.type === ItemType.WEAPON_RIFLE) {
                    sprite.setTexture('weapon_rifle');
                } else if (item.type === ItemType.WEAPON_SHOTGUN) {
                    sprite.setTexture('weapon_shotgun');
                } else if (item.type === ItemType.WEAPON_SNIPER) {
                    sprite.setTexture('weapon_sniper');
                }

                this.itemSprites.set(item.id, sprite);
            }

            sprite.setPosition(item.x, item.y).setVisible(true);
        });

        Array.from(this.itemSprites.entries()).forEach(([itemId, sprite]) => {
            if (!activeItemIds.has(itemId)) {
                sprite.destroy();
                this.itemSprites.delete(itemId);
            }
        });

        this.projectileGraphics.clear();
        state.projectiles.forEach((projectile: ProjectileState) => {
            this.projectileGraphics.fillStyle(projectile.color, 1).fillCircle(projectile.x, projectile.y, 4);
        });

        Object.entries(state.players).forEach(([id, player]) => {
            const sprite = this.playerSprites.get(id);
            const label = this.playerLabels.get(id);
            const healthBar = this.healthBars.get(id);

            if (sprite) {
                sprite.setPosition(player.x, player.y).setAlpha(player.isDead ? 0.3 : 1).setRotation(player.angle);
                if (id === this.playerId && player.isDead) {
                    this.phaseText.setText('SPECTATING');
                }
            }

            if (label) {
                label.setText(this.getLabelText(player));
                label.setPosition(player.x, player.y - 35);
            }

            if (healthBar) {
                healthBar.clear().fillStyle(0x000000, 0.5).fillRect(player.x - 16, player.y - 25, 32, 4);
                healthBar.fillStyle(player.health > 30 ? 0x00ff00 : 0xff0000, 1).fillRect(player.x - 16, player.y - 25, (player.health / player.maxHealth) * 32, 4);
            }

            if (id === this.playerId) {
                this.inventoryText.setText(
                    `Kills: ${player.kills} | Weapon: ${player.activeWeapon.toUpperCase()} | Ammo: ${player.inventory.ammo} | Medkits: ${player.inventory.medkits}`
                );
                if (player.health < this.lastHealth) {
                    this.cameras.main.shake(100, 0.01);
                }
                this.lastHealth = player.health;
            }
        });

        this.updateLobbyOverlay(state);
        this.updateGameOverOverlay(state);
    }

    private round(value: number): number {
        return Math.round(value * 10) / 10;
    }

    private updateLocalVelocity(sampleTime: number): void {
        const localSprite = this.playerSprites.get(this.playerId);
        if (!localSprite) {
            this.lastLocalSample = null;
            this.localVelocity = { x: 0, y: 0 };
            return;
        }

        if (!this.lastLocalSample) {
            this.lastLocalSample = { x: localSprite.x, y: localSprite.y, t: sampleTime };
            return;
        }

        const dt = (sampleTime - this.lastLocalSample.t) / 1000;
        if (dt <= 0) {
            return;
        }

        this.localVelocity = {
            x: (localSprite.x - this.lastLocalSample.x) / dt,
            y: (localSprite.y - this.lastLocalSample.y) / dt,
        };
        this.lastLocalSample = { x: localSprite.x, y: localSprite.y, t: sampleTime };
    }

    private renderGameToText(): string {
        const state = this.latestGameState;
        const localPlayer = state?.players[this.playerId];
        const localSprite = this.playerSprites.get(this.playerId);
        const players = state ? Object.values(state.players).map((player) => ({
            id: player.id,
            name: player.name,
            x: this.round(player.x),
            y: this.round(player.y),
            angle: this.round(player.angle),
            health: this.round(player.health),
            isDead: player.isDead,
            weapon: player.activeWeapon,
            kills: player.kills,
        })) : [];

        const payload = {
            coordinateSystem: 'origin=(0,0) top-left, +x right, +y down, units=pixels',
            connection: this.isConnected ? 'connected' : 'connecting',
            mode: state?.phase ?? 'connecting',
            world: {
                width: GAME_CONFIG.WORLD_WIDTH,
                height: GAME_CONFIG.WORLD_HEIGHT,
            },
            timers: {
                phaseTimer: state?.phaseTimer ?? null,
            },
            localPlayer: localPlayer ? {
                id: localPlayer.id,
                name: localPlayer.name,
                x: this.round(localPlayer.x),
                y: this.round(localPlayer.y),
                angle: this.round(localPlayer.angle),
                velocity: { x: this.round(this.localVelocity.x), y: this.round(this.localVelocity.y) },
                health: localPlayer.health,
                maxHealth: localPlayer.maxHealth,
                isDead: localPlayer.isDead,
                weapon: localPlayer.activeWeapon,
                inventory: localPlayer.inventory,
                kills: localPlayer.kills,
                input: this.lastInput,
            } : null,
            camera: {
                centerX: this.round(this.cameras.main.midPoint.x),
                centerY: this.round(this.cameras.main.midPoint.y),
                zoom: this.round(this.cameras.main.zoom),
                localSpriteVisible: Boolean(localSprite),
            },
            zone: state ? {
                x: this.round(state.zone.x),
                y: this.round(state.zone.y),
                radius: this.round(state.zone.radius),
            } : null,
            standings: state?.standings ?? [],
            ui: {
                lobbyVisible: this.lobbyOverlayEl?.style.display !== 'none',
                gameOverVisible: this.gameOverOverlayEl?.style.display !== 'none',
                hasSubmittedName: this.hasSubmittedName,
                pendingPlayerName: this.pendingPlayerName,
            },
            players,
            projectiles: state?.projectiles.slice(0, 24).map((projectile) => ({
                ownerId: projectile.ownerId,
                x: this.round(projectile.x),
                y: this.round(projectile.y),
                angle: this.round(projectile.angle),
                damage: projectile.damage,
            })) ?? [],
            items: state?.items.slice(0, 24).map((item) => ({
                id: item.id,
                type: item.type,
                x: this.round(item.x),
                y: this.round(item.y),
            })) ?? [],
            obstacles: state?.obstacles.slice(0, 20).map((obstacle) => ({
                x: this.round(obstacle.x),
                y: this.round(obstacle.y),
                width: this.round(obstacle.width),
                height: this.round(obstacle.height),
            })) ?? [],
            killFeed: this.recentKillFeed,
        };

        return JSON.stringify(payload);
    }

    private registerAutomationHooks(): void {
        const automationWindow = window as AutomationWindow;
        automationWindow.render_game_to_text = () => this.renderGameToText();
        automationWindow.advanceTime = (ms: number) => {
            return new Promise((resolve) => {
                this.time.delayedCall(Math.max(0, ms), () => resolve());
            });
        };
    }

    private unregisterAutomationHooks(): void {
        const automationWindow = window as AutomationWindow;
        delete automationWindow.render_game_to_text;
        delete automationWindow.advanceTime;
    }

    update(): void {
        const pointer = this.input.activePointer;
        const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
        const localSprite = this.playerSprites.get(this.playerId);
        const angle = localSprite ? Phaser.Math.Angle.Between(localSprite.x, localSprite.y, worldPoint.x, worldPoint.y) : 0;

        if (this.hasSubmittedName && (pointer.isDown || this.spaceKey.isDown)) {
            this.shoot(pointer.x, pointer.y);
        }

        const input: InputState = this.hasSubmittedName ? {
            up: this.cursors.up.isDown || this.wasd.W.isDown,
            down: this.cursors.down.isDown || this.wasd.S.isDown,
            left: this.cursors.left.isDown || this.wasd.A.isDown,
            right: this.cursors.right.isDown || this.wasd.D.isDown,
            angle,
        } : { ...DEFAULT_INPUT };

        const inputChanged = (
            input.up !== this.lastInput.up ||
            input.down !== this.lastInput.down ||
            input.left !== this.lastInput.left ||
            input.right !== this.lastInput.right ||
            input.angle !== this.lastInput.angle
        );

        if (inputChanged) {
            this.lastInput = { ...input };
            if (this.socket && this.playerId) {
                this.socket.emit(MessageType.PLAYER_INPUT, input);
            }
        }

        this.updateLocalVelocity(this.time.now);
    }
}
