import Phaser from 'phaser';
import { GameScene } from './scenes/GameScene';

const params = new URLSearchParams(window.location.search);
const rendererType = params.get('renderer') === 'webgl' ? Phaser.WEBGL : Phaser.CANVAS;

const config: Phaser.Types.Core.GameConfig = {
    type: rendererType,
    width: window.innerWidth,
    height: window.innerHeight,
    parent: 'game-container',
    backgroundColor: '#16213e',
    scene: [GameScene as any],
    scale: {
        mode: Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.CENTER_BOTH
    },
    render: {
        antialias: true,
        pixelArt: false,
        preserveDrawingBuffer: true,
    },
    disableContextMenu: true,
    physics: {
        default: 'arcade',
        arcade: {
            debug: false,
        },
    },
};

new Phaser.Game(config);
