import geckos, { GeckosServer, ServerChannel } from '@geckos.io/server';
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
  WeaponType,
  WEAPON_CONFIG,
  KillLogEntry,
  EffectType,
} from '@game/shared';

// Game state

const players: Map<string, PlayerState> = new Map();
const playerInputs: Map<string, InputState> = new Map();
const projectiles: Map<string, ProjectileState> = new Map();
const items: Map<string, ItemState> = new Map();
const lastShotTime: Map<string, number> = new Map();
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

// Initialize random obstacles
function initObstacles(): void {
  for (let i = 0; i < 100; i++) {
    obstacles.push({
      x: 100 + Math.random() * (GAME_CONFIG.WORLD_WIDTH - 300),
      y: 100 + Math.random() * (GAME_CONFIG.WORLD_HEIGHT - 300),
      width: 60 + Math.random() * 100,
      height: 60 + Math.random() * 100,
    });
  }
}
initObstacles();

// Collision detection (x, y are player center)
function checkCollision(centerX: number, centerY: number, size: number): boolean {
  const halfSize = size / 2;
  const left = centerX - halfSize;
  const right = centerX + halfSize;
  const top = centerY - halfSize;
  const bottom = centerY + halfSize;

  for (const obs of obstacles) {
    if (left < obs.x + obs.width && right > obs.x && top < obs.y + obs.height && bottom > obs.y) {
      return true;
    }
  }
  return false;
}

// Find a valid spawn point that doesn't collide with obstacles
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
  return { x: 100, y: 100 }; // Fallback
}

// Generate random color for player
function randomColor(): number {
  const colors = [0xff6b6b, 0x4ecdc4, 0x45b7d1, 0xf9ca24, 0x6c5ce7, 0xa29bfe];
  return colors[Math.floor(Math.random() * colors.length)];
}

// Create new player state
function createPlayer(id: string): PlayerState {
  const spawn = findValidSpawn();
  return {
    id,
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

// Spawn random items
function spawnItems(): void {
  if (gamePhase !== GamePhase.IN_GAME && gamePhase !== GamePhase.COUNTDOWN) return;
  while (items.size < GAME_CONFIG.MAX_ITEMS) {
    const id = `item_${itemIdCounter++}`;
    const types = [ItemType.MEDKIT, ItemType.AMMO, ItemType.WEAPON_RIFLE, ItemType.WEAPON_SHOTGUN, ItemType.WEAPON_SNIPER];
    const type = types[Math.floor(Math.random() * types.length)];

    items.set(id, {
      id,
      type,
      x: GAME_CONFIG.ITEM_SIZE / 2 + Math.random() * (GAME_CONFIG.WORLD_WIDTH - GAME_CONFIG.ITEM_SIZE),
      y: GAME_CONFIG.ITEM_SIZE / 2 + Math.random() * (GAME_CONFIG.WORLD_HEIGHT - GAME_CONFIG.ITEM_SIZE),
    });
  }
}

// Get current game state
function getGameState(): GameState {
  const playersObj: Record<string, PlayerState> = {};
  players.forEach((player, id) => {
    playersObj[id] = player;
  });
  return {
    players: playersObj,
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

// Update player position based on input
function updatePlayer(player: PlayerState, input: InputState, deltaTime: number): void {
  if (player.isDead) return;
  const speed = GAME_CONFIG.PLAYER_SPEED * deltaTime;
  const oldX = player.x;
  const oldY = player.y;

  player.angle = input.angle;

  if (input.up) player.y -= speed;
  if (input.down) player.y += speed;
  if (checkCollision(player.x, player.y, GAME_CONFIG.PLAYER_SIZE)) player.y = oldY;

  if (input.left) player.x -= speed;
  if (input.right) player.x += speed;
  if (checkCollision(player.x, player.y, GAME_CONFIG.PLAYER_SIZE)) player.x = oldX;

  // Clamp to world bounds
  const halfSize = GAME_CONFIG.PLAYER_SIZE / 2;
  player.x = Math.max(halfSize, Math.min(GAME_CONFIG.WORLD_WIDTH - halfSize, player.x));
  player.y = Math.max(halfSize, Math.min(GAME_CONFIG.WORLD_HEIGHT - halfSize, player.y));
}

// Initialize geckos.io server
const io: GeckosServer = geckos({
  cors: { origin: '*', allowAuthorization: true },
});

io.onConnection((channel: ServerChannel) => {
  const playerId = channel.id!;
  console.log(`Player connected: ${playerId}`);

  const player = createPlayer(playerId);
  players.set(playerId, player);
  playerInputs.set(playerId, { up: false, down: false, left: false, right: false, angle: 0 });

  channel.emit(MessageType.WELCOME, { playerId, gameState: getGameState() });
  channel.broadcast.emit(MessageType.PLAYER_JOIN, player);

  channel.on(MessageType.PLAYER_INPUT, (data: any) => {
    playerInputs.set(playerId, data as InputState);
  });

  channel.on(MessageType.SHOOT, (data: any) => {
    const angle = data as number;
    const p = players.get(playerId);
    if (!p || p.isDead || gamePhase !== GamePhase.IN_GAME) return;

    const weapon = WEAPON_CONFIG[p.activeWeapon];
    const now = Date.now();
    const lastShot = lastShotTime.get(playerId) || 0;

    if (now - lastShot < weapon.fireRate) return;
    if (p.inventory.ammo < weapon.ammoPerShot) return;

    p.inventory.ammo -= weapon.ammoPerShot;
    lastShotTime.set(playerId, now);

    io.emit(MessageType.EFFECT_EVENT, { x: p.x, y: p.y, type: EffectType.MUZZLE_FLASH });

    let color = 0xffff00; // Default yellow
    if (p.activeWeapon === WeaponType.SNIPER) color = 0xff0000; // Red
    if (p.activeWeapon === WeaponType.SHOTGUN) color = 0xffa500; // Orange

    for (let i = 0; i < weapon.projectileCount; i++) {
      const id = `p_${projectileIdCounter++}`;
      const spread = (Math.random() - 0.5) * weapon.spread;
      projectiles.set(id, {
        id, ownerId: playerId,
        x: p.x,
        y: p.y,
        angle: angle + spread,
        damage: weapon.damage,
        speed: weapon.projectileSpeed,
        color,
        maxRange: weapon.range,
        traveledDistance: 0,
        canPassThroughObstacles: p.activeWeapon === WeaponType.SNIPER,
      });
    }
  });

  channel.on(MessageType.USE_ITEM, (data: any) => {
    const p = players.get(playerId);
    if (!p || p.isDead) return;
    if (data === ItemType.MEDKIT && p.inventory.medkits > 0) {
      p.inventory.medkits--;
      p.health = Math.min(p.maxHealth, p.health + 40);
    }
  });

  channel.onDisconnect(() => {
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

// Game loop
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
      players.forEach(p => {
        p.isDead = false;
        p.health = 100;
        p.kills = 0;
      });
    }
  } else if (gamePhase === GamePhase.IN_GAME) {
    zone.radius = Math.max(0, zone.radius - GAME_CONFIG.ZONE_SHRINK_RATE * deltaTime);
    const alivePlayers = Array.from(players.values()).filter(p => !p.isDead);
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
      players.forEach(p => {
        const respawn = createPlayer(p.id);
        Object.assign(p, respawn);
      });
    }
  }

  spawnItems();

  damageTimer += deltaTime;
  const shouldApplyDamage = damageTimer >= 1.0;
  if (shouldApplyDamage) damageTimer = 0;

  players.forEach((player, id) => {
    if (player.isDead) return;
    updatePlayer(player, playerInputs.get(id) || { up: false, down: false, left: false, right: false, angle: 0 }, deltaTime);

    items.forEach((item, itemId) => {
      const dx = player.x - item.x;
      const dy = player.y - item.y;
      const pickupRadius = (GAME_CONFIG.PLAYER_SIZE + GAME_CONFIG.ITEM_SIZE) / 2;
      if (dx * dx + dy * dy < pickupRadius * pickupRadius) {
        if (item.type === ItemType.MEDKIT) player.inventory.medkits++;
        if (item.type === ItemType.AMMO) player.inventory.ammo += 40;
        if (item.type === ItemType.WEAPON_RIFLE) player.activeWeapon = WeaponType.RIFLE;
        if (item.type === ItemType.WEAPON_SHOTGUN) player.activeWeapon = WeaponType.SHOTGUN;
        if (item.type === ItemType.WEAPON_SNIPER) player.activeWeapon = WeaponType.SNIPER;
        items.delete(itemId);
      }
    });

    const dx = player.x - zone.x;
    const dy = player.y - zone.y;
    if (dx * dx + dy * dy > zone.radius * zone.radius && shouldApplyDamage && gamePhase === GamePhase.IN_GAME) {
      player.health -= GAME_CONFIG.ZONE_DAMAGE;
      if (player.health <= 0) {
        player.isDead = true;
        broadcastKill('ZONE', id, 'ZONE');
      }
    }
  });

  projectiles.forEach((proj, id) => {
    const step = proj.speed * deltaTime;
    proj.x += Math.cos(proj.angle) * step;
    proj.y += Math.sin(proj.angle) * step;
    proj.traveledDistance += step;

    if (
      proj.x < 0 || proj.x > GAME_CONFIG.WORLD_WIDTH ||
      proj.y < 0 || proj.y > GAME_CONFIG.WORLD_HEIGHT ||
      proj.traveledDistance > proj.maxRange
    ) {
      projectiles.delete(id);
      return;
    }

    if (!proj.canPassThroughObstacles && checkCollision(proj.x, proj.y, 4)) {
      io.emit(MessageType.EFFECT_EVENT, { x: proj.x, y: proj.y, type: EffectType.SPARKS });
      projectiles.delete(id);
      return;
    }

    players.forEach((p, pid) => {
      if (pid === proj.ownerId || p.isDead) return;
      const dx = proj.x - p.x;
      const dy = proj.y - p.y;
      const hitRadius = (GAME_CONFIG.PLAYER_SIZE + GAME_CONFIG.PROJECTILE_SIZE) / 2;
      if (dx * dx + dy * dy < hitRadius * hitRadius) {
        p.health -= proj.damage;
        io.emit(MessageType.EFFECT_EVENT, { x: proj.x, y: proj.y, type: EffectType.BLOOD });
        projectiles.delete(id);
        if (p.health <= 0) {
          p.isDead = true;
          const killer = players.get(proj.ownerId);
          if (killer) {
            killer.kills++;
            broadcastKill(proj.ownerId, pid, killer.activeWeapon);
          }
        }
      }
    });
  });

  io.emit(MessageType.GAME_STATE, getGameState());
}

const PORT = 9208;
io.listen(PORT);
console.log(`🎮 Game server running on port ${PORT}`);
setInterval(gameLoop, tickInterval);
