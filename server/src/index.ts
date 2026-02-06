import http from 'node:http';
import { Server, Socket } from 'socket.io';
import {
    GAME_CONFIG,
    MessageType,
    PlayerState,
    GameState,
    InputState,
    ZoneState,
    ProjectileState,
    ItemState,
    ItemType,
    GamePhase,
    ObstacleState,
    PlayerStanding,
    WeaponType,
    WEAPON_CONFIG,
    KillLogEntry,
    EffectType,
} from './shared/index.js';

const players: Map<string, PlayerState> = new Map();
const playerInputs: Map<string, InputState> = new Map();
const projectiles: Map<string, ProjectileState> = new Map();
const items: Map<string, ItemState> = new Map();
const lastShotTime: Map<string, number> = new Map();
const activeMatchParticipants: Map<string, PlayerStanding> = new Map();
const obstacles: ObstacleState[] = [];
let gamePhase: GamePhase = GamePhase.LOBBY;
let phaseTimer = 0;
let winnerId: string | null = null;

const zone: ZoneState = {
    x: GAME_CONFIG.WORLD_WIDTH / 2,
    y: GAME_CONFIG.WORLD_HEIGHT / 2,
    radius: GAME_CONFIG.ZONE_INITIAL_RADIUS,
};

let projectileIdCounter = 0;
let itemIdCounter = 0;

const DEFAULT_INPUT: InputState = { up: false, down: false, left: false, right: false, angle: 0 };

function sanitizePlayerName(name: string | null | undefined): string {
    const raw = (name || '').trim();
    const normalized = raw.replace(/\s+/g, ' ').slice(0, 18);
    if (!normalized) {
        return '';
    }
    return normalized;
}

function initObstacles(): void {
    obstacles.length = 0;

    const baseArea = 2500 * 1900;
    const baseObstacleCount = 100;
    const areaScale = (GAME_CONFIG.WORLD_WIDTH * GAME_CONFIG.WORLD_HEIGHT) / baseArea;
    const obstacleCount = Math.max(baseObstacleCount, Math.round(baseObstacleCount * areaScale));

    for (let i = 0; i < obstacleCount; i++) {
        obstacles.push({
            x: 100 + Math.random() * (GAME_CONFIG.WORLD_WIDTH - 300),
            y: 100 + Math.random() * (GAME_CONFIG.WORLD_HEIGHT - 300),
            width: 60 + Math.random() * 100,
            height: 60 + Math.random() * 100,
        });
    }
}
initObstacles();

function checkCollision(centerX: number, centerY: number, size: number): boolean {
    const halfSize = size / 2;
    const left = centerX - halfSize;
    const right = centerX + halfSize;
    const top = centerY - halfSize;
    const bottom = centerY + halfSize;

    for (const obstacle of obstacles) {
        if (left < obstacle.x + obstacle.width && right > obstacle.x && top < obstacle.y + obstacle.height && bottom > obstacle.y) {
            return true;
        }
    }

    return false;
}

function findValidSpawn(): { x: number; y: number } {
    const size = GAME_CONFIG.PLAYER_SIZE;
    const halfSize = size / 2;
    let attempts = 0;

    while (attempts < 50) {
        const x = halfSize + Math.random() * (GAME_CONFIG.WORLD_WIDTH - size);
        const y = halfSize + Math.random() * (GAME_CONFIG.WORLD_HEIGHT - size);
        if (!checkCollision(x, y, size)) {
            return { x, y };
        }
        attempts++;
    }

    return { x: 100, y: 100 };
}

function findValidItemSpawn(): { x: number; y: number } {
    const itemSize = GAME_CONFIG.ITEM_SIZE;
    const halfSize = itemSize / 2;
    let attempts = 0;

    while (attempts < 80) {
        const x = halfSize + Math.random() * (GAME_CONFIG.WORLD_WIDTH - itemSize);
        const y = halfSize + Math.random() * (GAME_CONFIG.WORLD_HEIGHT - itemSize);
        if (!checkCollision(x, y, itemSize + 12)) {
            return { x, y };
        }
        attempts++;
    }

    const fallback = findValidSpawn();
    return { x: fallback.x, y: fallback.y };
}

function randomColor(): number {
    const colors = [0xff6b6b, 0x4ecdc4, 0x45b7d1, 0xf9ca24, 0x6c5ce7, 0xa29bfe];
    return colors[Math.floor(Math.random() * colors.length)];
}

function createPlayer(id: string, requestedName?: string): PlayerState {
    const spawn = findValidSpawn();
    const fallbackName = `Player-${id.slice(0, 4)}`;
    const name = sanitizePlayerName(requestedName) || fallbackName;
    return {
        id,
        name,
        x: spawn.x,
        y: spawn.y,
        angle: 0,
        color: randomColor(),
        health: 100,
        maxHealth: 100,
        isDead: false,
        activeWeapon: WeaponType.PISTOL,
        kills: 0,
        inventory: {
            medkits: 0,
            ammo: 100,
        },
    };
}

function getStandings(): PlayerStanding[] {
    return Array.from(players.values())
        .map((player) => ({
            id: player.id,
            name: player.name,
            kills: player.kills,
            isDead: player.isDead,
        }))
        .sort((left, right) => {
            if (right.kills !== left.kills) {
                return right.kills - left.kills;
            }
            return left.name.localeCompare(right.name);
        });
}

function getActiveMatchStandings(): PlayerStanding[] {
    return Array.from(activeMatchParticipants.values()).sort((left, right) => {
        if (right.kills !== left.kills) {
            return right.kills - left.kills;
        }
        return left.name.localeCompare(right.name);
    });
}

function spawnItems(): void {
    if (gamePhase !== GamePhase.IN_GAME && gamePhase !== GamePhase.COUNTDOWN) {
        return;
    }

    while (items.size < GAME_CONFIG.MAX_ITEMS) {
        const id = `item_${itemIdCounter++}`;
        const types = [ItemType.MEDKIT, ItemType.AMMO, ItemType.WEAPON_RIFLE, ItemType.WEAPON_SHOTGUN, ItemType.WEAPON_SNIPER];
        const type = types[Math.floor(Math.random() * types.length)];
        const spawn = findValidItemSpawn();

        items.set(id, {
            id,
            type,
            x: spawn.x,
            y: spawn.y,
        });
    }
}

function getGameState(): GameState {
    const playersObj: Record<string, PlayerState> = {};
    players.forEach((player, id) => {
        playersObj[id] = player;
    });

    const standings = gamePhase === GamePhase.GAME_OVER
        ? getActiveMatchStandings()
        : getStandings();

    return {
        players: playersObj,
        standings,
        projectiles: Array.from(projectiles.values()),
        items: Array.from(items.values()),
        obstacles,
        zone: { ...zone },
        phase: gamePhase,
        phaseTimer: Math.ceil(phaseTimer),
        winnerId,
        timestamp: Date.now(),
    };
}

function updatePlayer(player: PlayerState, input: InputState, deltaTime: number): void {
    if (player.isDead) {
        return;
    }

    const speed = GAME_CONFIG.PLAYER_SPEED * deltaTime;
    const oldX = player.x;
    const oldY = player.y;

    player.angle = input.angle;

    if (input.up) {
        player.y -= speed;
    }
    if (input.down) {
        player.y += speed;
    }
    if (checkCollision(player.x, player.y, GAME_CONFIG.PLAYER_SIZE)) {
        player.y = oldY;
    }

    if (input.left) {
        player.x -= speed;
    }
    if (input.right) {
        player.x += speed;
    }
    if (checkCollision(player.x, player.y, GAME_CONFIG.PLAYER_SIZE)) {
        player.x = oldX;
    }

    const halfSize = GAME_CONFIG.PLAYER_SIZE / 2;
    player.x = Math.max(halfSize, Math.min(GAME_CONFIG.WORLD_WIDTH - halfSize, player.x));
    player.y = Math.max(halfSize, Math.min(GAME_CONFIG.WORLD_HEIGHT - halfSize, player.y));
}

const httpServer = http.createServer();
const io = new Server(httpServer, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
    },
    transports: ['websocket', 'polling'],
});

io.on('connection', (socket: Socket) => {
    const playerId = socket.id;
    console.log(`Player connected: ${playerId}`);

    const player = createPlayer(playerId);
    players.set(playerId, player);
    playerInputs.set(playerId, { ...DEFAULT_INPUT });

    socket.emit(MessageType.WELCOME, { playerId, gameState: getGameState() });
    socket.broadcast.emit(MessageType.PLAYER_JOIN, player);

    socket.on(MessageType.PLAYER_INPUT, (data: InputState) => {
        playerInputs.set(playerId, data);
    });

    socket.on(MessageType.SET_NAME, (requestedName: string) => {
        const playerState = players.get(playerId);
        if (!playerState) {
            return;
        }

        const sanitized = sanitizePlayerName(requestedName);
        if (!sanitized) {
            return;
        }
        playerState.name = sanitized;
    });

    socket.on(MessageType.SHOOT, (angle: number) => {
        const playerState = players.get(playerId);
        if (!playerState || playerState.isDead || gamePhase !== GamePhase.IN_GAME) {
            return;
        }

        const weapon = WEAPON_CONFIG[playerState.activeWeapon];
        const now = Date.now();
        const lastShot = lastShotTime.get(playerId) || 0;
        if (now - lastShot < weapon.fireRate) {
            return;
        }

        if (playerState.inventory.ammo < weapon.ammoPerShot) {
            return;
        }

        playerState.inventory.ammo -= weapon.ammoPerShot;
        lastShotTime.set(playerId, now);

        io.emit(MessageType.EFFECT_EVENT, { x: playerState.x, y: playerState.y, type: EffectType.MUZZLE_FLASH });

        let color = 0xffff00;
        if (playerState.activeWeapon === WeaponType.SNIPER) {
            color = 0xff0000;
        }
        if (playerState.activeWeapon === WeaponType.SHOTGUN) {
            color = 0xffa500;
        }

        for (let i = 0; i < weapon.projectileCount; i++) {
            const projectileId = `p_${projectileIdCounter++}`;
            const spread = (Math.random() - 0.5) * weapon.spread;
            projectiles.set(projectileId, {
                id: projectileId,
                ownerId: playerId,
                x: playerState.x,
                y: playerState.y,
                angle: angle + spread,
                damage: weapon.damage,
                speed: weapon.projectileSpeed,
                color,
                maxRange: weapon.range,
                traveledDistance: 0,
                canPassThroughObstacles: playerState.activeWeapon === WeaponType.SNIPER,
            });
        }
    });

    socket.on(MessageType.USE_ITEM, (itemType: ItemType) => {
        const playerState = players.get(playerId);
        if (!playerState || playerState.isDead) {
            return;
        }

        if (itemType === ItemType.MEDKIT && playerState.inventory.medkits > 0) {
            playerState.inventory.medkits--;
            playerState.health = Math.min(playerState.maxHealth, playerState.health + 40);
        }
    });

    socket.on('disconnect', () => {
        if (gamePhase === GamePhase.IN_GAME || gamePhase === GamePhase.GAME_OVER) {
            const participant = activeMatchParticipants.get(playerId);
            const player = players.get(playerId);
            if (participant && player) {
                participant.kills = player.kills;
                participant.name = player.name;
                participant.isDead = true;
            }
        } else {
            activeMatchParticipants.delete(playerId);
        }

        players.delete(playerId);
        playerInputs.delete(playerId);
        lastShotTime.delete(playerId);
        io.emit(MessageType.PLAYER_LEAVE, { id: playerId });
    });
});

function broadcastKill(killerId: string, victimId: string, weapon: WeaponType | 'ZONE') {
    const log: KillLogEntry = {
        killerId,
        victimId,
        weapon,
        timestamp: Date.now(),
    };
    io.emit(MessageType.KILL_LOG, log);
}

let lastTime = Date.now();
let damageTimer = 0;
const tickInterval = 1000 / GAME_CONFIG.TICK_RATE;

function gameLoop(): void {
    const now = Date.now();
    const deltaTime = (now - lastTime) / 1000;
    lastTime = now;

    if (gamePhase === GamePhase.LOBBY) {
        if (players.size >= GAME_CONFIG.LOBBY_MIN_PLAYERS) {
            gamePhase = GamePhase.COUNTDOWN;
            phaseTimer = GAME_CONFIG.COUNTDOWN_DURATION;
        }
        zone.radius = GAME_CONFIG.ZONE_INITIAL_RADIUS;
    } else if (gamePhase === GamePhase.COUNTDOWN) {
        phaseTimer -= deltaTime;
        if (phaseTimer <= 0) {
            gamePhase = GamePhase.IN_GAME;
            activeMatchParticipants.clear();
            players.forEach((player) => {
                player.isDead = false;
                player.health = 100;
                player.kills = 0;
                activeMatchParticipants.set(player.id, {
                    id: player.id,
                    name: player.name,
                    kills: 0,
                    isDead: false,
                });
            });
        }
    } else if (gamePhase === GamePhase.IN_GAME) {
        zone.radius = Math.max(0, zone.radius - GAME_CONFIG.ZONE_SHRINK_RATE * deltaTime);
        const alivePlayers = Array.from(players.values()).filter((player) => !player.isDead);
        if (alivePlayers.length <= 1 && players.size >= 1) {
            winnerId = alivePlayers.length === 1 ? alivePlayers[0].id : null;
            gamePhase = GamePhase.GAME_OVER;
            phaseTimer = GAME_CONFIG.GAME_OVER_DURATION;
        }
    } else if (gamePhase === GamePhase.GAME_OVER) {
        phaseTimer -= deltaTime;
        if (phaseTimer <= 0) {
            gamePhase = GamePhase.LOBBY;
            items.clear();
            projectiles.clear();
            activeMatchParticipants.clear();
            players.forEach((player) => {
                const respawn = createPlayer(player.id, player.name);
                Object.assign(player, respawn);
            });
        }
    }

    spawnItems();

    damageTimer += deltaTime;
    const shouldApplyDamage = damageTimer >= 1.0;
    if (shouldApplyDamage) {
        damageTimer = 0;
    }

    players.forEach((player, id) => {
        if (player.isDead) {
            const participant = activeMatchParticipants.get(id);
            if (participant) {
                participant.kills = player.kills;
                participant.name = player.name;
                participant.isDead = true;
            }
            return;
        }

        updatePlayer(player, playerInputs.get(id) || DEFAULT_INPUT, deltaTime);

        items.forEach((item, itemId) => {
            const dx = player.x - item.x;
            const dy = player.y - item.y;
            const pickupRadius = (GAME_CONFIG.PLAYER_SIZE + GAME_CONFIG.ITEM_SIZE) / 2;
            if (dx * dx + dy * dy < pickupRadius * pickupRadius) {
                if (item.type === ItemType.MEDKIT) {
                    player.inventory.medkits++;
                }
                if (item.type === ItemType.AMMO) {
                    player.inventory.ammo += 40;
                }
                if (item.type === ItemType.WEAPON_RIFLE) {
                    player.activeWeapon = WeaponType.RIFLE;
                }
                if (item.type === ItemType.WEAPON_SHOTGUN) {
                    player.activeWeapon = WeaponType.SHOTGUN;
                }
                if (item.type === ItemType.WEAPON_SNIPER) {
                    player.activeWeapon = WeaponType.SNIPER;
                }
                items.delete(itemId);
            }
        });

        const zoneDx = player.x - zone.x;
        const zoneDy = player.y - zone.y;
        if (zoneDx * zoneDx + zoneDy * zoneDy > zone.radius * zone.radius && shouldApplyDamage && gamePhase === GamePhase.IN_GAME) {
            player.health -= GAME_CONFIG.ZONE_DAMAGE;
            if (player.health <= 0) {
                player.isDead = true;
                const participant = activeMatchParticipants.get(id);
                if (participant) {
                    participant.isDead = true;
                }
                broadcastKill('ZONE', id, 'ZONE');
            }
        }

        const participant = activeMatchParticipants.get(id);
        if (participant) {
            participant.kills = player.kills;
            participant.name = player.name;
            participant.isDead = player.isDead;
        }
    });

    projectiles.forEach((projectile, id) => {
        const step = projectile.speed * deltaTime;
        projectile.x += Math.cos(projectile.angle) * step;
        projectile.y += Math.sin(projectile.angle) * step;
        projectile.traveledDistance += step;

        if (
            projectile.x < 0 ||
            projectile.x > GAME_CONFIG.WORLD_WIDTH ||
            projectile.y < 0 ||
            projectile.y > GAME_CONFIG.WORLD_HEIGHT ||
            projectile.traveledDistance > projectile.maxRange
        ) {
            projectiles.delete(id);
            return;
        }

        if (!projectile.canPassThroughObstacles && checkCollision(projectile.x, projectile.y, 4)) {
            io.emit(MessageType.EFFECT_EVENT, { x: projectile.x, y: projectile.y, type: EffectType.SPARKS });
            projectiles.delete(id);
            return;
        }

        players.forEach((player, playerId) => {
            if (playerId === projectile.ownerId || player.isDead) {
                return;
            }

            const dx = projectile.x - player.x;
            const dy = projectile.y - player.y;
            const hitRadius = (GAME_CONFIG.PLAYER_SIZE + GAME_CONFIG.PROJECTILE_SIZE) / 2;
            if (dx * dx + dy * dy < hitRadius * hitRadius) {
                player.health -= projectile.damage;
                io.emit(MessageType.EFFECT_EVENT, { x: projectile.x, y: projectile.y, type: EffectType.BLOOD });
                projectiles.delete(id);

                if (player.health <= 0) {
                    player.isDead = true;
                    const victimParticipant = activeMatchParticipants.get(playerId);
                    if (victimParticipant) {
                        victimParticipant.isDead = true;
                    }
                    const killer = players.get(projectile.ownerId);
                    if (killer) {
                        killer.kills++;
                        const killerParticipant = activeMatchParticipants.get(projectile.ownerId);
                        if (killerParticipant) {
                            killerParticipant.kills = killer.kills;
                            killerParticipant.name = killer.name;
                        }
                        broadcastKill(projectile.ownerId, playerId, killer.activeWeapon);
                    }
                }
            }
        });
    });

    io.emit(MessageType.GAME_STATE, getGameState());
}

const PORT = Number.parseInt(process.env.PORT || '9208', 10);
httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`🎮 Game server running on port ${PORT}`);
});
setInterval(gameLoop, tickInterval);
