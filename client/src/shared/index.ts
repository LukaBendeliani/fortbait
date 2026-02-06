// Game constants
export const GAME_CONFIG = {
    TICK_RATE: 60,
    WORLD_WIDTH: 3200,
    WORLD_HEIGHT: 2432,
    PLAYER_SIZE: 32,
    PLAYER_SPEED: 250,
    ZONE_INITIAL_RADIUS: 1536,
    ZONE_SHRINK_RATE: 5,
    ZONE_DAMAGE: 10, // damage per second
    PROJECTILE_SIZE: 8,
    ITEM_SIZE: 16,
    MAX_ITEMS: 77,
    LOBBY_MIN_PLAYERS: 2,
    COUNTDOWN_DURATION: 10, // seconds
    GAME_OVER_DURATION: 5, // seconds
} as const;

export enum WeaponType {
    PISTOL = 'pistol',
    RIFLE = 'rifle',
    SHOTGUN = 'shotgun',
    SNIPER = 'sniper',
}

export interface WeaponStats {
    damage: number;
    fireRate: number;
    projectileCount: number;
    spread: number;
    projectileSpeed: number;
    ammoPerShot: number;
    range: number;
}

export const WEAPON_CONFIG: Record<WeaponType, WeaponStats> = {
    [WeaponType.PISTOL]: {
        damage: 15,
        fireRate: 400,
        projectileCount: 1,
        spread: 0,
        projectileSpeed: 500,
        ammoPerShot: 1,
        range: 500,
    },
    [WeaponType.RIFLE]: {
        damage: 20,
        fireRate: 150,
        projectileCount: 1,
        spread: 0.05,
        projectileSpeed: 600,
        ammoPerShot: 1,
        range: 800,
    },
    [WeaponType.SHOTGUN]: {
        damage: 10,
        fireRate: 800,
        projectileCount: 8,
        spread: 0.4,
        projectileSpeed: 400,
        ammoPerShot: 5,
        range: 300,
    },
    [WeaponType.SNIPER]: {
        damage: 80,
        fireRate: 1500,
        projectileCount: 1,
        spread: 0,
        projectileSpeed: 1200,
        ammoPerShot: 10,
        range: 2000,
    },
};

// Message types for client-server communication
export enum MessageType {
    PLAYER_JOIN = 'player_join',
    PLAYER_LEAVE = 'player_leave',
    PLAYER_INPUT = 'player_input',
    SET_NAME = 'set_name',
    GAME_STATE = 'game_state',
    WELCOME = 'welcome',
    SHOOT = 'shoot',
    USE_ITEM = 'use_item',
    KILL_LOG = 'kill_log',
    EFFECT_EVENT = 'effect_event',
}

export enum ItemType {
    MEDKIT = 'medkit',
    AMMO = 'ammo',
    WEAPON_RIFLE = 'weapon_rifle',
    WEAPON_SHOTGUN = 'weapon_shotgun',
    WEAPON_SNIPER = 'weapon_sniper',
}

export enum GamePhase {
    LOBBY = 'lobby',
    COUNTDOWN = 'countdown',
    IN_GAME = 'in_game',
    GAME_OVER = 'game_over',
}

export enum EffectType {
    BLOOD = 'blood',
    SPARKS = 'sparks',
    MUZZLE_FLASH = 'muzzle_flash',
}

export interface EffectState {
    x: number;
    y: number;
    type: EffectType;
}

export interface KillLogEntry {
    killerId: string;
    victimId: string;
    weapon: WeaponType | 'ZONE';
    timestamp: number;
}

// Zone state
export interface ZoneState {
    x: number;
    y: number;
    radius: number;
}

// Item state
export interface ItemState {
    id: string;
    type: ItemType;
    x: number;
    y: number;
}

// Obstacle state
export interface ObstacleState {
    x: number;
    y: number;
    width: number;
    height: number;
}

// Projectile state
export interface ProjectileState {
    id: string;
    ownerId: string;
    x: number;
    y: number;
    angle: number;
    damage: number;
    speed: number;
    color: number;
    maxRange: number;
    traveledDistance: number;
    canPassThroughObstacles: boolean;
}

// Player state
export interface PlayerState {
    id: string;
    name: string;
    x: number;
    y: number;
    angle: number;
    color: number;
    health: number;
    maxHealth: number;
    isDead: boolean;
    activeWeapon: WeaponType;
    kills: number;
    inventory: {
        medkits: number;
        ammo: number;
    };
}

export interface PlayerStanding {
    id: string;
    name: string;
    kills: number;
    isDead: boolean;
}

// Input state from client
export interface InputState {
    up: boolean;
    down: boolean;
    left: boolean;
    right: boolean;
    angle: number;
}

// Game state snapshot
export interface GameState {
    players: Record<string, PlayerState>;
    standings: PlayerStanding[];
    projectiles: ProjectileState[];
    items: ItemState[];
    obstacles: ObstacleState[];
    zone: ZoneState;
    phase: GamePhase;
    phaseTimer: number;
    winnerId: string | null;
    timestamp: number;
}

// Welcome message sent to new players
export interface WelcomeMessage {
    playerId: string;
    gameState: GameState;
}
