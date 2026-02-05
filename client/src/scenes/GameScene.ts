import Phaser from 'phaser';
import geckos, { ClientChannel } from '@geckos.io/client';
import {
    GAME_CONFIG,
    MessageType,
    PlayerState,
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

export class GameScene extends Phaser.Scene {
    private channel!: ClientChannel;
    private playerId = '';
    private isConnected = false;
    private latestGameState: GameState | null = null;

    private playerSprites: Map<string, Phaser.GameObjects.Sprite> = new Map();
    private playerLabels: Map<string, Phaser.GameObjects.Text> = new Map();
    private healthBars: Map<string, Phaser.GameObjects.Graphics> = new Map();
    private itemSprites: Map<string, Phaser.GameObjects.Sprite> = new Map();
    private obstacleSprites: Phaser.GameObjects.Sprite[] = [];

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

    constructor() {
        super({ key: 'GameScene' });
    }

    preload() {
        this.load.atlasXML('characters', '/assets/spritesheet_characters.png', '/assets/spritesheet_characters.xml');
        this.load.spritesheet('tiles', '/assets/spritesheet_tiles.png', { frameWidth: 64, frameHeight: 64 });
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

        this.add.tileSprite(0, 0, GAME_CONFIG.WORLD_WIDTH, GAME_CONFIG.WORLD_HEIGHT, 'tiles', 0)
            .setOrigin(0, 0)
            .setDepth(-1)
            .setAlpha(0.85)
            .setTint(0x88aa88);

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
        this.fKey = this.input.keyboard!.addKey('F');

        this.hKey.on('down', () => {
            if (this.channel && this.playerId) {
                this.channel.emit(MessageType.USE_ITEM, ItemType.MEDKIT);
            }
        });

        this.fKey.on('down', () => this.toggleFullscreen());
        this.scale.on(Phaser.Scale.Events.RESIZE, this.handleResize, this);
        this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
            this.scale.off(Phaser.Scale.Events.RESIZE, this.handleResize, this);
            this.unregisterAutomationHooks();
        });

        this.registerAutomationHooks();
        this.connectToServer();
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

    private getServerConnectionConfig() {
        const envUrl = (import.meta.env.VITE_SERVER_URL || '').trim();
        const envPort = Number.parseInt(import.meta.env.VITE_SERVER_PORT || '', 10);
        const serverUrl = envUrl || window.location.hostname;
        const serverPort = Number.isFinite(envPort) ? envPort : 9208;
        return { serverUrl, serverPort };
    }

    private connectToServer(): void {
        const { serverUrl, serverPort } = this.getServerConnectionConfig();
        const normalizedUrl = serverUrl.startsWith('http') ? serverUrl : `${window.location.protocol}//${serverUrl}`;

        this.connectionText.setText('Connecting...').setVisible(true);
        this.channel = geckos({ url: normalizedUrl, port: serverPort });

        this.channel.onConnect((error) => {
            if (error) {
                this.isConnected = false;
                this.connectionText.setText('Connection Failed').setVisible(true);
                return;
            }

            this.isConnected = true;
            this.connectionText.setVisible(false);

            this.channel.on(MessageType.WELCOME, (data: unknown) => {
                const welcome = data as WelcomeMessage;
                this.playerId = welcome.playerId;
                this.latestGameState = welcome.gameState;
                this.updateObstacles(welcome.gameState.obstacles);
                Object.values(welcome.gameState.players).forEach((player) => this.createPlayerSprite(player));
            });
            this.channel.on(MessageType.PLAYER_JOIN, (data: unknown) => this.createPlayerSprite(data as PlayerState));
            this.channel.on(MessageType.PLAYER_LEAVE, (data: unknown) => this.removePlayerSprite((data as { id: string }).id));
            this.channel.on(MessageType.GAME_STATE, (data: unknown) => this.updateGameState(data as GameState));
            this.channel.on(MessageType.KILL_LOG, (data: unknown) => this.addKillLog(data as KillLogEntry));
            this.channel.on(MessageType.EFFECT_EVENT, (data: unknown) => this.triggerEffect(data as EffectState));
        });

        this.channel.onDisconnect(() => {
            this.isConnected = false;
            this.latestGameState = null;
            this.connectionText.setText('Disconnected').setVisible(true);
        });
    }

    private addKillLog(entry: KillLogEntry) {
        const { width } = this.scale;
        const killer = entry.killerId === this.playerId ? 'YOU' : (entry.killerId === 'ZONE' ? 'ZONE' : entry.killerId.slice(0, 4));
        const victim = entry.victimId === this.playerId ? 'YOU' : entry.victimId.slice(0, 4);
        const weapon = entry.weapon.toUpperCase();
        const feedLine = `${killer} [${weapon}] ${victim}`;

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
        if (!this.channel || !this.playerId) {
            return;
        }

        const sprite = this.playerSprites.get(this.playerId);
        if (!sprite || sprite.alpha !== 1) {
            return;
        }

        const worldPoint = this.cameras.main.getWorldPoint(targetX, targetY);
        this.channel.emit(MessageType.SHOOT, Phaser.Math.Angle.Between(sprite.x, sprite.y, worldPoint.x, worldPoint.y));
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
        const label = this.add.text(player.x, player.y - 35, player.id === this.playerId ? 'YOU' : player.id.slice(0, 4), { fontSize: '12px' }).setOrigin(0.5);
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
        this.obstacleSprites.forEach((sprite) => sprite.destroy());
        this.obstacleSprites = [];
        obstacles.forEach((obstacle) => {
            const obstacleSprite = this.add.sprite(obstacle.x, obstacle.y, 'tiles', 14).setOrigin(0, 0).setDisplaySize(obstacle.width, obstacle.height);
            this.obstacleSprites.push(obstacleSprite);
        });
    }

    private updateGameState(state: GameState): void {
        this.latestGameState = state;

        if (state.phase === GamePhase.LOBBY) {
            this.phaseText.setText('WAITING FOR PLAYERS...');
        } else if (state.phase === GamePhase.COUNTDOWN) {
            this.phaseText.setText(`STARTING IN ${Math.max(0, state.phaseTimer)}`);
        } else if (state.phase === GamePhase.GAME_OVER) {
            this.phaseText.setText(`WINNER: ${state.winnerId === this.playerId ? 'YOU!' : state.winnerId?.slice(0, 4) || 'NONE'}`);
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
                    sprite.setFrame(84);
                } else if (item.type === ItemType.AMMO) {
                    sprite.setFrame(152);
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

        if (pointer.isDown || this.spaceKey.isDown) {
            this.shoot(pointer.x, pointer.y);
        }

        const input: InputState = {
            up: this.cursors.up.isDown || this.wasd.W.isDown,
            down: this.cursors.down.isDown || this.wasd.S.isDown,
            left: this.cursors.left.isDown || this.wasd.A.isDown,
            right: this.cursors.right.isDown || this.wasd.D.isDown,
            angle,
        };

        const inputChanged = (
            input.up !== this.lastInput.up ||
            input.down !== this.lastInput.down ||
            input.left !== this.lastInput.left ||
            input.right !== this.lastInput.right ||
            input.angle !== this.lastInput.angle
        );

        if (inputChanged) {
            this.lastInput = { ...input };
            if (this.channel && this.playerId) {
                this.channel.emit(MessageType.PLAYER_INPUT, input);
            }
        }

        this.updateLocalVelocity(this.time.now);
    }
}
