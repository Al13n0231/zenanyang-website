import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import GUI from 'lil-gui';
import './App.css';

function App() {
    const containerRef = useRef<HTMLDivElement>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!containerRef.current || !videoRef.current) return;

        let scene: THREE.Scene, camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer;
        let particlesMesh: THREE.Points;
        let handProgress = 0;
        let animationId: number;
        let gui: GUI;
        let cameraUtils: any;
        let hands: any;

        const config = {
            particleColor: '#00ffff',
            particleSize: 2.0,
            dispersionStrength: 500,
        };

        // --- 1. Three.js 初始化 ---
        const initThree = () => {
            scene = new THREE.Scene();
            camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
            camera.position.z = 300;

            renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
            renderer.setSize(window.innerWidth, window.innerHeight);
            renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

            if (containerRef.current) {
                containerRef.current.innerHTML = '';
                containerRef.current.appendChild(renderer.domElement);
            }
        };

        // --- 2. 粒子生成 ---
        const createParticlesFromImage = (imageUrl: string) => {
            const loader = new THREE.TextureLoader();
            loader.load(imageUrl, (texture) => {
                const img = texture.image;
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                if (!ctx) return;

                const width = 200;
                const scale = width / img.width;
                const height = img.height * scale;

                canvas.width = width;
                canvas.height = height;
                ctx.drawImage(img, 0, 0, width, height);

                const imgData = ctx.getImageData(0, 0, width, height);
                const data = imgData.data;

                const positions: number[] = [];
                const targetPositions: number[] = [];
                const initialPositions: number[] = [];

                for (let y = 0; y < height; y++) {
                    for (let x = 0; x < width; x++) {
                        const index = (y * width + x) * 4;
                        const r = data[index];     // 红
                        const g = data[index + 1]; // 绿
                        const b = data[index + 2]; // 蓝
                        const alpha = data[index + 3]; // 透明度

                        const isDarkPixel = (r + g + b) < 380;
                        const isNotTransparent = alpha > 100;

                        if (isNotTransparent && isDarkPixel) {
                            const tx = (x - width / 2) * 2;
                            const ty = -(y - height / 2) * 2;
                            targetPositions.push(tx, ty, 0);

                            const rx = (Math.random() - 0.5) * config.dispersionStrength * 2;
                            const ry = (Math.random() - 0.5) * config.dispersionStrength * 2;
                            const rz = (Math.random() - 0.5) * config.dispersionStrength * 2;
                            positions.push(rx, ry, rz);
                            initialPositions.push(rx, ry, rz);
                        }
                    }
                }

                const geometry = new THREE.BufferGeometry();
                geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
                geometry.setAttribute('targetPosition', new THREE.Float32BufferAttribute(targetPositions, 3));
                geometry.setAttribute('initialPosition', new THREE.Float32BufferAttribute(initialPositions, 3));

                const material = new THREE.PointsMaterial({
                    color: new THREE.Color(config.particleColor),
                    size: config.particleSize,
                    transparent: true,
                    opacity: 0.8,
                    blending: THREE.AdditiveBlending
                });

                if (particlesMesh) scene.remove(particlesMesh);
                particlesMesh = new THREE.Points(geometry, material);
                scene.add(particlesMesh);
            });
        };

        // --- 3. 手势识别 (使用全局 window 变量) ---
        const initHandTracking = () => {
            // @ts-ignore
            if (!window.Hands || !window.Camera) {
                console.error("MediaPipe 脚本未加载完成，请刷新页面");
                return;
            }

            // @ts-ignore
            hands = new window.Hands({
                locateFile: (file: string) => {
                    return `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;
                }
            });

            hands.setOptions({
                maxNumHands: 1,
                modelComplexity: 1,
                minDetectionConfidence: 0.5,
                minTrackingConfidence: 0.5
            });

            hands.onResults((results: any) => {
                if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
                    const landmarks = results.multiHandLandmarks[0];
                    const thumbTip = landmarks[4];
                    const indexTip = landmarks[8];
                    const distance = Math.sqrt(
                        Math.pow(thumbTip.x - indexTip.x, 2) +
                        Math.pow(thumbTip.y - indexTip.y, 2)
                    );

                    let targetVal = THREE.MathUtils.mapLinear(distance, 0.05, 0.2, 1, 0);
                    targetVal = THREE.MathUtils.clamp(targetVal, 0, 1);
                    handProgress += (targetVal - handProgress) * 0.1;
                }
            });

            if (videoRef.current) {
                // @ts-ignore
                cameraUtils = new window.Camera(videoRef.current, {
                    onFrame: async () => {
                        if(videoRef.current && hands) await hands.send({image: videoRef.current});
                    },
                    width: 640,
                    height: 480
                });

                cameraUtils.start()
                    .then(() => {
                        console.log("摄像头启动成功");
                        setLoading(false);
                    })
                    .catch((e: any) => console.error(e));
            }
        };

        // --- 4. 动画循环 ---
        const animate = () => {
            animationId = requestAnimationFrame(animate);

            if (particlesMesh) {
                const positions = particlesMesh.geometry.attributes.position.array as Float32Array;
                const initial = particlesMesh.geometry.attributes.initialPosition.array as Float32Array;
                const target = particlesMesh.geometry.attributes.targetPosition.array as Float32Array;

                particlesMesh.rotation.y += 0.002;

                for (let i = 0; i < positions.length; i++) {
                    positions[i] = initial[i] + (target[i] - initial[i]) * handProgress;
                }
                particlesMesh.geometry.attributes.position.needsUpdate = true;
            }
            renderer.render(scene, camera);
        };

        const initGUI = () => {
            gui = new GUI();
            gui.addColor(config, 'particleColor').onChange((v: string) => {
                if (particlesMesh) (particlesMesh.material as THREE.PointsMaterial).color.set(v);
            });
            gui.add(config, 'particleSize', 0.5, 5).onChange((v: number) => {
                if (particlesMesh) (particlesMesh.material as THREE.PointsMaterial).size = v;
            });
        };

        // --- 启动顺序 ---
        initThree();
        // 确保你的图片在 public 目录下，名字一致
        createParticlesFromImage('/tesseract-odyssey-scala-altered-state-polaris-geometric-cover.png');
        initGUI();
        initHandTracking();
        animate();

        const handleResize = () => {
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);
        };
        window.addEventListener('resize', handleResize);

        return () => {
            window.removeEventListener('resize', handleResize);
            cancelAnimationFrame(animationId);
            if(gui) gui.destroy();
            if(hands) hands.close();
            if(cameraUtils) cameraUtils.stop();
        };
    }, []);

    return (
        <>
            <div ref={containerRef} style={{ width: '100vw', height: '100vh', overflow: 'hidden', background: '#000' }} />
            <video ref={videoRef} style={{ display: 'none' }} playsInline />
            {loading && (
                <div style={{
                    position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
                    color: 'white', fontFamily: 'sans-serif', pointerEvents: 'none', textAlign: 'center'
                }}>
                    <div>正在加载模型...</div>
                    <div style={{fontSize: '12px', opacity: 0.7}}>如果不消失，请尝试刷新页面</div>
                </div>
            )}
        </>
    );
}

export default App;