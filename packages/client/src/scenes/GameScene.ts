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
} from '@game/shared';

export class GameScene extends Phaser.Scene {
  private channel!: ClientChannel;
  private playerId: string = '';
  private playerSprites: Map<string, Phaser.GameObjects.Sprite> = new Map();
  private playerLabels: Map<string, Phaser.GameObjects.Text> = new Map();
  private healthBars: Map<string, Phaser.GameObjects.Graphics> = new Map();
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: { W: Phaser.Input.Keyboard.Key; A: Phaser.Input.Keyboard.Key; S: Phaser.Input.Keyboard.Key; D: Phaser.Input.Keyboard.Key };
  private spaceKey!: Phaser.Input.Keyboard.Key;
  private hKey!: Phaser.Input.Keyboard.Key;
  private lastInput: InputState = { up: false, down: false, left: false, right: false, angle: 0 };
  private connectionText!: Phaser.GameObjects.Text;
  private inventoryText!: Phaser.GameObjects.Text;
  private phaseText!: Phaser.GameObjects.Text;
  private killFeedTexts: Phaser.GameObjects.Text[] = [];
  private zoneGraphics!: Phaser.GameObjects.Graphics;
  private projectileGraphics!: Phaser.GameObjects.Graphics;
  private itemGraphics!: Phaser.GameObjects.Graphics;
  private itemSprites: Map<string, Phaser.GameObjects.Sprite> = new Map();
  private obstacleSprites: Phaser.GameObjects.Sprite[] = [];
  private obstacleGraphics!: Phaser.GameObjects.Graphics;
  private minimapCamera!: Phaser.Cameras.Scene2D.Camera;

  private bloodEmitter!: Phaser.GameObjects.Particles.ParticleEmitter;
  private sparksEmitter!: Phaser.GameObjects.Particles.ParticleEmitter;
  private flashEmitter!: Phaser.GameObjects.Particles.ParticleEmitter;

  private lastHealth: number = 100;

  constructor() {
    super({ key: 'GameScene' });
  }

  preload() {
    console.log(this.obstacleGraphics, this.itemGraphics);
    this.load.atlas('characters', '/assets/spritesheet_characters.png', '/assets/spritesheet_characters.xml');
    this.load.spritesheet('tiles', '/assets/spritesheet_tiles.png', { frameWidth: 64, frameHeight: 64 });
    this.load.image('weapon_pistol', '/assets/weapon_pistol.png');
    this.load.image('weapon_rifle', '/assets/weapon_rifle.png');
    this.load.image('weapon_shotgun', '/assets/weapon_shotgun.png');
    this.load.image('weapon_sniper', '/assets/weapon_sniper.png');
  }

  create(): void {
    const { width, height } = this.scale;

    this.cameras.main.setBounds(0, 0, GAME_CONFIG.WORLD_WIDTH, GAME_CONFIG.WORLD_HEIGHT);

    const minimapSize = 150;
    this.minimapCamera = this.cameras.add(width - minimapSize - 10, 10, minimapSize, minimapSize)
      .setZoom(minimapSize / GAME_CONFIG.WORLD_WIDTH)
      .setName('minimap')
      .setBackgroundColor(0x000000)
      .setAlpha(0.8)
      .setBounds(0, 0, GAME_CONFIG.WORLD_WIDTH, GAME_CONFIG.WORLD_HEIGHT);

    this.connectionText = this.add.text(width / 2, height / 2, 'Connecting...', { fontSize: '24px', color: '#4ecdc4' }).setOrigin(0.5).setScrollFactor(0);
    this.inventoryText = this.add.text(10, 10, '', { fontSize: '16px', color: '#ffffff', backgroundColor: '#00000088' }).setDepth(10).setScrollFactor(0);
    this.phaseText = this.add.text(width / 2, 50, '', { fontSize: '32px', color: '#ffffff', stroke: '#000000', strokeThickness: 4 }).setOrigin(0.5).setDepth(10).setScrollFactor(0);

    this.projectileGraphics = this.add.graphics();

    // Create Ground
    this.add.tileSprite(0, 0, GAME_CONFIG.WORLD_WIDTH, GAME_CONFIG.WORLD_HEIGHT, 'tiles', 0)
      .setOrigin(0, 0)
      .setDepth(-1)
      .setAlpha(0.8)
      .setTint(0x999999);

    this.obstacleGraphics = this.add.graphics();
    this.zoneGraphics = this.add.graphics();
    this.itemGraphics = this.add.graphics();

    // Particles
    this.createPixelTexture();
    this.bloodEmitter = this.add.particles(0, 0, 'pixel', {
      color: [0xff0000, 0x880000],
      speed: { min: 50, max: 100 },
      scale: { start: 1, end: 0 },
      lifespan: 400,
      emitting: false
    });

    this.sparksEmitter = this.add.particles(0, 0, 'pixel', {
      color: [0xffff00, 0xffa500],
      speed: { min: 80, max: 150 },
      scale: { start: 1, end: 0 },
      lifespan: 300,
      emitting: false
    });

    this.flashEmitter = this.add.particles(0, 0, 'pixel', {
      color: [0xffffff, 0xffff00],
      scale: { start: 2, end: 0 },
      lifespan: 100,
      speed: 20,
      emitting: false
    });

    this.minimapCamera.ignore([this.connectionText, this.inventoryText, this.phaseText, this.bloodEmitter, this.sparksEmitter, this.flashEmitter]);

    this.cursors = this.input.keyboard!.createCursorKeys();
    this.wasd = {
      W: this.input.keyboard!.addKey('W'),
      A: this.input.keyboard!.addKey('A'),
      S: this.input.keyboard!.addKey('S'),
      D: this.input.keyboard!.addKey('D'),
    };
    this.spaceKey = this.input.keyboard!.addKey('SPACE');
    this.hKey = this.input.keyboard!.addKey('H');

    this.hKey.on('down', () => {
      if (this.channel && this.playerId) this.channel.emit(MessageType.USE_ITEM, ItemType.MEDKIT);
    });

    this.connectToServer();
  }

  private createPixelTexture() {
    const graphics = this.add.graphics();
    graphics.fillStyle(0xffffff);
    graphics.fillRect(0, 0, 4, 4);
    graphics.generateTexture('pixel', 4, 4);
    graphics.destroy();
  }

  init() {
    this.createPixelTexture();
  }

  private addKillLog(entry: KillLogEntry) {
    const { width } = this.scale;
    const killer = entry.killerId === this.playerId ? 'YOU' : (entry.killerId === 'ZONE' ? 'ZONE' : entry.killerId.slice(0, 4));
    const victim = entry.victimId === this.playerId ? 'YOU' : entry.victimId.slice(0, 4);
    const weapon = entry.weapon.toUpperCase();

    const text = this.add.text(width - 170, 170 + this.killFeedTexts.length * 20, `${killer} [${weapon}] ${victim}`, {
      fontSize: '14px',
      color: entry.victimId === this.playerId ? '#ff4d4d' : (entry.killerId === this.playerId ? '#4dff4d' : '#ffffff'),
      backgroundColor: '#00000044',
      padding: { x: 5, y: 2 }
    }).setScrollFactor(0).setDepth(10).setOrigin(1, 0);

    this.minimapCamera.ignore(text);
    this.killFeedTexts.push(text);

    this.time.delayedCall(5000, () => {
      text.destroy();
      this.killFeedTexts = this.killFeedTexts.filter(t => t !== text);
      this.killFeedTexts.forEach((t, i) => {
        t.setY(170 + i * 20);
      });
    });
  }

  private shoot(targetX: number, targetY: number): void {
    if (this.channel && this.playerId) {
      const sprite = this.playerSprites.get(this.playerId);
      if (sprite && sprite.alpha === 1) {
        const worldPoint = this.cameras.main.getWorldPoint(targetX, targetY);
        this.channel.emit(MessageType.SHOOT, Phaser.Math.Angle.Between(sprite.x, sprite.y, worldPoint.x, worldPoint.y));
      }
    }
  }

  private triggerEffect(effect: EffectState) {
    if (effect.type === EffectType.BLOOD) {
      this.bloodEmitter.explode(10, effect.x, effect.y);
    } else if (effect.type === EffectType.SPARKS) {
      this.sparksEmitter.explode(8, effect.x, effect.y);
    } else if (effect.type === EffectType.MUZZLE_FLASH) {
      this.flashEmitter.explode(5, effect.x, effect.y);

      const shooter = Array.from(this.playerSprites.entries()).find(([_, s]) =>
        Phaser.Math.Distance.Between(s.x, s.y, effect.x, effect.y) < 5
      );
      if (shooter) {
        this.tweens.add({
          targets: shooter[1],
          scale: 0.8,
          duration: 50,
          yoyo: true
        });
      }
    }
  }

  private connectToServer(): void {
    const serverUrl = import.meta.env.VITE_SERVER_URL || window.location.hostname;
    const serverPort = parseInt(import.meta.env.VITE_SERVER_PORT) || 9208;

    console.log(`Connecting to server at ${serverUrl}:${serverPort}`);
    this.channel = geckos({
      url: serverUrl.startsWith('http') ? serverUrl : `${window.location.protocol}//${serverUrl}`,
      port: serverPort
    });

    this.channel.onConnect((error) => {
      if (error) return this.connectionText.setText('Connection Failed');
      this.connectionText.destroy();
      this.channel.on(MessageType.WELCOME, (data: any) => {
        const welcome = data as WelcomeMessage;
        this.playerId = welcome.playerId;
        Object.values(welcome.gameState.players).forEach(p => this.createPlayerSprite(p));
        this.updateObstacles(welcome.gameState.obstacles);
      });
      this.channel.on(MessageType.PLAYER_JOIN, (data: any) => this.createPlayerSprite(data as PlayerState));
      this.channel.on(MessageType.PLAYER_LEAVE, (data: any) => this.removePlayerSprite((data as { id: string }).id));
      this.channel.on(MessageType.GAME_STATE, (data: any) => this.updateGameState(data as GameState));
      this.channel.on(MessageType.KILL_LOG, (data: any) => this.addKillLog(data as KillLogEntry));
      this.channel.on(MessageType.EFFECT_EVENT, (data: any) => this.triggerEffect(data as EffectState));
      return;
    });
  }

  private getSkinForPlayer(id: string): string {
    const skins = ['manBlue_gun.png', 'manBrown_gun.png', 'manOld_gun.png', 'robot1_gun.png', 'soldier1_gun.png', 'survivor1_gun.png', 'womanGreen_gun.png'];
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash);
    return skins[Math.abs(hash) % skins.length];
  }

  private createPlayerSprite(player: PlayerState): void {
    const skin = this.getSkinForPlayer(player.id);
    const sprite = this.add.sprite(player.x, player.y, 'characters', skin).setOrigin(0.5);
    const label = this.add.text(player.x, player.y - 35, player.id === this.playerId ? 'YOU' : player.id.slice(0, 4), { fontSize: '12px' }).setOrigin(0.5);
    const hb = this.add.graphics();

    this.playerSprites.set(player.id, sprite);
    this.playerLabels.set(player.id, label);
    this.healthBars.set(player.id, hb);

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

  private updateObstacles(obstacles: any[]) {
    this.obstacleSprites.forEach(s => s.destroy());
    this.obstacleSprites = [];
    obstacles.forEach(o => {
      const s = this.add.sprite(o.x, o.y, 'tiles', 14).setOrigin(0, 0).setDisplaySize(o.width, o.height);
      this.obstacleSprites.push(s);
    });
  }

  private updateGameState(state: GameState): void {
    if (state.phase === GamePhase.LOBBY) this.phaseText.setText('WAITING FOR PLAYERS...');
    else if (state.phase === GamePhase.COUNTDOWN) this.phaseText.setText(`STARTING IN ${state.phaseTimer}`);
    else if (state.phase === GamePhase.GAME_OVER) this.phaseText.setText(`WINNER: ${state.winnerId === this.playerId ? 'YOU!' : state.winnerId?.slice(0, 4) || 'NONE'}`);
    else this.phaseText.setText('');

    this.zoneGraphics.clear().lineStyle(4, 0xff0000, 0.5).strokeCircle(state.zone.x, state.zone.y, state.zone.radius);

    // Update Items
    this.itemSprites.forEach(s => s.setVisible(false));
    state.items.forEach((item: ItemState) => {
      let sprite = this.itemSprites.get(item.id);
      if (!sprite) {
        let texture = 'weapon_pistol';
        if (item.type === ItemType.MEDKIT) texture = 'tiles';
        else if (item.type === ItemType.AMMO) texture = 'tiles';

        sprite = this.add.sprite(item.x, item.y, texture).setOrigin(0.5).setScale(0.5);
        if (item.type === ItemType.MEDKIT) sprite.setFrame(84);
        else if (item.type === ItemType.AMMO) sprite.setFrame(152);
        else if (item.type === ItemType.WEAPON_RIFLE) sprite.setTexture('weapon_rifle');
        else if (item.type === ItemType.WEAPON_SHOTGUN) sprite.setTexture('weapon_shotgun');
        else if (item.type === ItemType.WEAPON_SNIPER) sprite.setTexture('weapon_sniper');

        this.itemSprites.set(item.id, sprite);
      }
      sprite.setPosition(item.x, item.y).setVisible(true);
    });

    this.projectileGraphics.clear();
    state.projectiles.forEach((p: ProjectileState) => {
      this.projectileGraphics.fillStyle(p.color, 1).fillCircle(p.x, p.y, 4);
    });

    Object.entries(state.players).forEach(([id, p]: [string, PlayerState]) => {
      const sprite = this.playerSprites.get(id);
      const label = this.playerLabels.get(id);
      const hb = this.healthBars.get(id);
      if (sprite) {
        sprite.setPosition(p.x, p.y).setAlpha(p.isDead ? 0.3 : 1).setRotation(p.angle);
        if (id === this.playerId && p.isDead) this.phaseText.setText('SPECTATING');
      }
      if (label) label.setPosition(p.x, p.y - 35);
      if (hb) {
        hb.clear().fillStyle(0x000000, 0.5).fillRect(p.x - 16, p.y - 25, 32, 4);
        hb.fillStyle(p.health > 30 ? 0x00ff00 : 0xff0000, 1).fillRect(p.x - 16, p.y - 25, (p.health / p.maxHealth) * 32, 4);
      }
      if (id === this.playerId) {
        this.inventoryText.setText(`Kills: ${p.kills} | Weapon: ${p.activeWeapon.toUpperCase()} | Ammo: ${p.inventory.ammo} | Medkits: ${p.inventory.medkits}`);
        if (p.health < this.lastHealth) this.cameras.main.shake(100, 0.01);
        this.lastHealth = p.health;
      }
    });
  }

  update(): void {
    const pointer = this.input.activePointer;
    const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const selfSprite = this.playerSprites.get(this.playerId);
    const angle = selfSprite ? Phaser.Math.Angle.Between(selfSprite.x, selfSprite.y, worldPoint.x, worldPoint.y) : 0;

    if (pointer.isDown || this.spaceKey.isDown) this.shoot(pointer.x, pointer.y);

    const input: InputState = {
      up: this.cursors.up.isDown || this.wasd.W.isDown,
      down: this.cursors.down.isDown || this.wasd.S.isDown,
      left: this.cursors.left.isDown || this.wasd.A.isDown,
      right: this.cursors.right.isDown || this.wasd.D.isDown,
      angle: angle
    };

    if (JSON.stringify(input) !== JSON.stringify(this.lastInput)) {
      this.lastInput = { ...input };
      if (this.channel && this.playerId) {
        this.channel.emit(MessageType.PLAYER_INPUT, input);
      }
    }
  }
}
