import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { Results } from '@mediapipe/hands';
import * as mpHands from '@mediapipe/hands';
import { Camera } from '@mediapipe/camera_utils';
import GUI from 'lil-gui';
import './App.css';// 确保你有这个文件，或者保留原本的样式引入

function App() {
    const containerRef = useRef<HTMLDivElement>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!containerRef.current || !videoRef.current) return;

        // --- 变量定义 ---
        let scene: THREE.Scene, camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer;
        let particlesMesh: THREE.Points;
        let handProgress = 0;
        let animationId: number;

        // 配置
        const config = {
            particleColor: '#00ffff',
            particleSize: 2.0,
            dispersionStrength: 500,
        };

        // --- 1. 初始化 Three.js ---
        const initThree = () => {
            scene = new THREE.Scene();
            camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
            camera.position.z = 300;

            renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
            renderer.setSize(window.innerWidth, window.innerHeight);
            renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

            // 清空容器并添加 canvas
            if (containerRef.current) {
                containerRef.current.innerHTML = '';
                containerRef.current.appendChild(renderer.domElement);
            }
        };

        // --- 2. 图像转粒子 (核心逻辑) ---
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
                        const alpha = data[index + 3];

                        if (alpha > 128) {
                            const tx = (x - width / 2) * 2;
                            const ty = -(y - height / 2) * 2;
                            const tz = 0;
                            targetPositions.push(tx, ty, tz);

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

        // --- 3. 手势识别 ---
        const onResults = (results: Results) => {
            if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
                const landmarks = results.multiHandLandmarks[0];
                const thumbTip = landmarks[4];
                const indexTip = landmarks[8];
                const distance = Math.sqrt(
                    Math.pow(thumbTip.x - indexTip.x, 2) +
                    Math.pow(thumbTip.y - indexTip.y, 2)
                );

                // 映射逻辑：捏合=聚合(1)，张开=散开(0)
                let targetVal = THREE.MathUtils.mapLinear(distance, 0.05, 0.2, 1, 0);
                targetVal = THREE.MathUtils.clamp(targetVal, 0, 1);
                handProgress += (targetVal - handProgress) * 0.1;
            }
        };

        const initHandTracking = () => {
            // --- 终极防御性写法 ---
            // 这里的逻辑是：如果 mpHands.Hands 存在就用它，否则尝试 mpHands.default.Hands
            // @ts-ignore
            const HandsClass = mpHands.Hands || (mpHands.default ? mpHands.default.Hands : null);

            if (!HandsClass) {
                console.error("无法加载 MediaPipe Hands 类", mpHands);
                return;
            }

            const hands = new HandsClass({
                locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
            });
            hands.setOptions({
                maxNumHands: 1,
                modelComplexity: 1,
                minDetectionConfidence: 0.5,
                minTrackingConfidence: 0.5
            });
            hands.onResults(onResults);

            if (videoRef.current) {
                const cameraUtils = new Camera(videoRef.current, {
                    onFrame: async () => {
                        if(videoRef.current) await hands.send({image: videoRef.current});
                    },
                    width: 640,
                    height: 480
                });
                cameraUtils.start().then(() => setLoading(false));
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

        // --- 5. UI 初始化 ---
        const initGUI = () => {
            const gui = new GUI();
            gui.domElement.style.position = 'absolute';
            gui.domElement.style.top = '10px';
            gui.domElement.style.right = '10px';

            gui.addColor(config, 'particleColor').onChange((v: string) => {
                if (particlesMesh) (particlesMesh.material as THREE.PointsMaterial).color.set(v);
            });
            gui.add(config, 'particleSize', 0.5, 5).onChange((v: number) => {
                if (particlesMesh) (particlesMesh.material as THREE.PointsMaterial).size = v;
            });

            // 清理 GUI
            return () => gui.destroy();
        };

        // --- 执行顺序 ---
        initThree();

        // ⚠️ 注意：这里使用 base64 图片作为示例。
        // 实际项目中，请把图片（如 heart.png）放在 public 文件夹下，然后用 '/heart.png' 引用
        const base64Atom = '/atom-symbol-silhouette-f35580-xl.png'
        createParticlesFromImage(base64Atom);

        initHandTracking();
        const cleanupGUI = initGUI();
        animate();

        // 窗口调整
        const handleResize = () => {
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);
        };
        window.addEventListener('resize', handleResize);

        // 清理函数
        return () => {
            window.removeEventListener('resize', handleResize);
            cancelAnimationFrame(animationId);
            cleanupGUI();
            // 这里可以添加更多 Three.js 资源释放逻辑
        };
    }, []);

    return (
        <>
            <div
                ref={containerRef}
                style={{ width: '100vw', height: '100vh', overflow: 'hidden', background: '#000' }}
            />
            <video
                ref={videoRef}
                style={{ display: 'none' }}
                playsInline
            />
            {loading && (
                <div style={{
                    position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
                    color: 'white', fontFamily: 'sans-serif', pointerEvents: 'none'
                }}>
                    正在启动摄像头与模型... (请允许摄像头权限)
                </div>
            )}
        </>
    );
}

export default App;