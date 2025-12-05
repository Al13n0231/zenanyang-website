import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import './App.css';

// --- Shader: 顶点着色器 (处理运动、物理、混沌) ---
const vertexShader = `
  uniform float uTime;
  uniform float uZoom; // 0.0 (远/暗) -> 1.0 (近/亮/混沌)
  
  attribute float aSize;
  attribute float aSpeed;
  attribute float aAngle;
  attribute float aRadius;
  attribute vec3 aRandom; // 用于噪点方向
  attribute vec3 aColor;

  varying vec3 vColor;
  varying float vAlpha;

  // 伪随机函数
  float random (vec2 st) {
      return fract(sin(dot(st.xy, vec2(12.9898,78.233))) * 43758.5453123);
  }

  void main() {
    vColor = aColor;
    
    // 1. 开普勒轨道运动 (Kepler's Laws)
    // 速度与半径平方根成反比。uTime * aSpeed 让粒子动起来
    float currentAngle = aAngle + uTime * aSpeed;
    
    vec3 stablePos;
    stablePos.x = cos(currentAngle) * aRadius;
    stablePos.z = sin(currentAngle) * aRadius;
    stablePos.y = 0.0; // 基础是在平面上，如果是球体则是另一套逻辑

    // 如果是球体本体粒子，y轴也有值
    if (aSpeed == 0.0) { // 标记为本体粒子
       stablePos = position; 
       // 让本体也缓慢自转
       float s = sin(uTime * 0.1);
       float c = cos(uTime * 0.1);
       float x = stablePos.x * c - stablePos.z * s;
       float z = stablePos.x * s + stablePos.z * c;
       stablePos.x = x;
       stablePos.z = z;
    }

    // 2. 交互缩放逻辑
    // uZoom 越大，粒子越靠近相机 (或者模型放大)
    float scaleFactor = 0.5 + uZoom * 4.0; // 0.5倍 -> 4.5倍
    vec3 finalPos = stablePos * scaleFactor;

    // 3. 混沌噪点 (Brownian/Chaos Motion)
    // 当 uZoom > 0.7 时开始介入，越接近 1.0 越剧烈
    float chaosThreshold = 0.7;
    if (uZoom > chaosThreshold) {
        float chaosStrength = (uZoom - chaosThreshold) / (1.0 - chaosThreshold); // 0 -> 1
        
        // 高频震动
        float timeFreq = uTime * 20.0;
        vec3 noiseOffset = vec3(
            sin(timeFreq * aRandom.x),
            cos(timeFreq * aRandom.y),
            sin(timeFreq * aRandom.z)
        );
        
        // 粒子炸开效果：位置偏移 + 震动
        finalPos += noiseOffset * chaosStrength * 2.0 * scaleFactor; 
        
        // 打破轨道：稍微打散原始位置
        finalPos += aRandom * chaosStrength * 5.0 * scaleFactor;
    }

    vec4 mvPosition = modelViewMatrix * vec4(finalPos, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    // 4. 大小随距离衰减 (透视效果)
    gl_PointSize = aSize * (300.0 / -mvPosition.z);
    
    // 5. 亮度物理规律 (小暗大亮)
    // 基础亮度 + Zoom增强。模拟光强随距离平方反比 (这里简化为线性增强以获得更好视觉控制)
    float brightness = 0.2 + pow(uZoom, 1.5) * 2.0; 
    vAlpha = brightness;
  }
`;

// --- Shader: 片元着色器 (处理光泽、形状) ---
const fragmentShader = `
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    // 制作圆形软粒子
    float r = distance(gl_PointCoord, vec2(0.5, 0.5));
    if (r > 0.5) discard;

    // 辉光效果 (中心亮边缘暗)
    float glow = 1.0 - (r * 2.0);
    glow = pow(glow, 1.5); 

    gl_FragColor = vec4(vColor, vAlpha * glow);
  }
`;

function App() {
    const containerRef = useRef<HTMLDivElement>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const materialRef = useRef<THREE.ShaderMaterial | null>(null);
    const [loading, setLoading] = useState(true);
    const [isFullscreen, setIsFullscreen] = useState(false);

    // 平滑过渡用的 ref
    const targetZoomRef = useRef(0);
    const currentZoomRef = useRef(0);

    useEffect(() => {
        if (!containerRef.current || !videoRef.current) return;

        let scene: THREE.Scene, camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer;
        let particlesMesh: THREE.Points;
        let animationId: number;
        let cameraUtils: any;
        let hands: any;

        // --- 1. Three.js 初始化 ---
        const initThree = () => {
            scene = new THREE.Scene();
            // 背景深邃宇宙黑
            scene.background = new THREE.Color('#050505');
            scene.fog = new THREE.FogExp2(0x050505, 0.002);

            camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);
            camera.position.set(0, 40, 100); // 稍微俯视
            camera.lookAt(0, 0, 0);

            renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
            renderer.setSize(window.innerWidth, window.innerHeight);
            renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

            if (containerRef.current) {
                containerRef.current.innerHTML = '';
                containerRef.current.appendChild(renderer.domElement);
            }
        };

        // --- 2. 创建土星与粒子环 (核心数据生成) ---
        const createSaturnSystem = () => {
            const particleCount = 60000; // 6万个粒子，保证极致画面

            const positions = new Float32Array(particleCount * 3);
            const sizes = new Float32Array(particleCount);
            const speeds = new Float32Array(particleCount);
            const angles = new Float32Array(particleCount);
            const radii = new Float32Array(particleCount);
            const randoms = new Float32Array(particleCount * 3);
            const colors = new Float32Array(particleCount * 3);

            const colorPlanet = new THREE.Color('#E0C895'); // 土星米黄色
            const colorRingInner = new THREE.Color('#C9B086');
            const colorRingOuter = new THREE.Color('#788691'); // 冰环蓝灰色

            for (let i = 0; i < particleCount; i++) {
                let x, y, z, r, speed, angle, size;
                let color = new THREE.Color();

                // 30% 的粒子构成土星本体 (球体)
                if (i < particleCount * 0.3) {
                    // 球体分布
                    const theta = Math.random() * Math.PI * 2;
                    const phi = Math.acos((Math.random() * 2) - 1);
                    const radius = 15 + Math.random() * 1; // 半径15左右

                    x = radius * Math.sin(phi) * Math.cos(theta);
                    y = radius * Math.sin(phi) * Math.sin(theta);
                    z = radius * Math.cos(phi);

                    r = 0; // 本体不参与开普勒轨道计算
                    speed = 0; // 标记为本体
                    angle = 0;
                    size = Math.random() * 2.5 + 0.5;

                    // 纬度条纹色彩模拟
                    if (Math.abs(z) < 3) color.set('#D6C298');
                    else if (Math.abs(z) > 13) color.set('#8C8068');
                    else color.copy(colorPlanet);

                } else {
                    // 70% 的粒子构成环 (圆盘)
                    // 环的半径范围：25 -> 65
                    // 卡西尼缝 (Cassini Division): 大概在 50-55 之间粒子稀疏

                    r = 25 + Math.random() * 40;

                    // 制造环缝
                    if (r > 48 && r < 52) {
                        if (Math.random() > 0.2) r += 5; // 大部分粒子移出缝隙
                    }

                    angle = Math.random() * Math.PI * 2;

                    // 基础位置 (Vertex Shader 会重写 x,z)
                    x = Math.cos(angle) * r;
                    z = Math.sin(angle) * r;
                    y = (Math.random() - 0.5) * 0.5; // 环极其薄

                    // 开普勒定律模拟：速度 = 根号(GM/r)
                    // 越近越快
                    speed = 5.0 / Math.sqrt(r);

                    // 颜色渐变：内圈暖色，外圈冷色
                    const t = (r - 25) / 40;
                    color.lerpColors(colorRingInner, colorRingOuter, t);

                    size = Math.random() * 1.5 + 0.2;
                }

                positions[i * 3] = x;
                positions[i * 3 + 1] = y;
                positions[i * 3 + 2] = z;

                sizes[i] = size;
                speeds[i] = speed;
                angles[i] = angle;
                radii[i] = r;

                colors[i * 3] = color.r;
                colors[i * 3 + 1] = color.g;
                colors[i * 3 + 2] = color.b;

                // 随机噪点方向 (用于混沌模式)
                randoms[i * 3] = (Math.random() - 0.5);
                randoms[i * 3 + 1] = (Math.random() - 0.5);
                randoms[i * 3 + 2] = (Math.random() - 0.5);
            }

            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
            geometry.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));
            geometry.setAttribute('aAngle', new THREE.BufferAttribute(angles, 1));
            geometry.setAttribute('aRadius', new THREE.BufferAttribute(radii, 1));
            geometry.setAttribute('aRandom', new THREE.BufferAttribute(randoms, 3));
            geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));

            const material = new THREE.ShaderMaterial({
                vertexShader,
                fragmentShader,
                uniforms: {
                    uTime: { value: 0 },
                    uZoom: { value: 0 },
                },
                transparent: true,
                depthWrite: false, // 粒子不需要遮挡，增强发光感
                blending: THREE.AdditiveBlending // 叠加发光
            });

            materialRef.current = material;
            particlesMesh = new THREE.Points(geometry, material);

            // 整体倾斜土星，展示更美的角度
            particlesMesh.rotation.z = 25 * (Math.PI / 180);
            particlesMesh.rotation.x = 10 * (Math.PI / 180);

            scene.add(particlesMesh);
        };

        // --- 3. 手势识别 ---
        const initHandTracking = () => {
            // @ts-ignore
            if (!window.Hands || !window.Camera) {
                console.error("MediaPipe 未加载，请确保 index.html 引入了 CDN");
                return;
            }
            // @ts-ignore
            hands = new window.Hands({
                locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1646424915/${file}`
            });

            hands.setOptions({
                maxNumHands: 1,
                modelComplexity: 1,
                minDetectionConfidence: 0.5,
                minTrackingConfidence: 0.5
            });

            hands.onResults((results: any) => {
                if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
                    const lm = results.multiHandLandmarks[0];
                    // 计算拇指(4)和食指(8)的距离
                    const d = Math.sqrt(Math.pow(lm[4].x - lm[8].x, 2) + Math.pow(lm[4].y - lm[8].y, 2));

                    // 映射距离到 Zoom
                    // 距离通常在 0.02 (闭合) 到 0.25 (张开) 之间
                    // 我们希望：张开(大) -> Zoom=1.0, 闭合(小) -> Zoom=0.0
                    let val = THREE.MathUtils.mapLinear(d, 0.03, 0.2, 0, 1);
                    val = THREE.MathUtils.clamp(val, 0, 1);

                    targetZoomRef.current = val;
                } else {
                    // 手移开时，缓慢回到中间状态或最小状态，看你喜好
                    targetZoomRef.current = targetZoomRef.current * 0.95;
                }
            });

            if (videoRef.current) {
                // @ts-ignore
                cameraUtils = new window.Camera(videoRef.current, {
                    onFrame: async () => {
                        if(videoRef.current && hands) await hands.send({image: videoRef.current});
                    },
                    width: 640, height: 480
                });
                cameraUtils.start().then(() => setLoading(false));
            }
        };

        // --- 4. 动画循环 ---
        const animate = () => {
            animationId = requestAnimationFrame(animate);

            // 平滑 Zoom 数值 (Lerp)
            currentZoomRef.current += (targetZoomRef.current - currentZoomRef.current) * 0.08;

            if (materialRef.current) {
                materialRef.current.uniforms.uTime.value += 0.005; // 时间流速
                materialRef.current.uniforms.uZoom.value = currentZoomRef.current;
            }

            // 稍微缓慢旋转整个场景，增加动态感
            if (particlesMesh) {
                particlesMesh.rotation.y += 0.0005;
            }

            renderer.render(scene, camera);
        };

        const handleResize = () => {
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);
        };
        window.addEventListener('resize', handleResize);

        // 启动
        initThree();
        createSaturnSystem();
        initHandTracking();
        animate();

        return () => {
            window.removeEventListener('resize', handleResize);
            cancelAnimationFrame(animationId);
            if(hands) hands.close();
            if(cameraUtils) cameraUtils.stop();
        };
    }, []);

    // 全屏切换
    const toggleFullscreen = () => {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen();
            setIsFullscreen(true);
        } else {
            document.exitFullscreen();
            setIsFullscreen(false);
        }
    };

    return (
        <div className="app-container">
            <div ref={containerRef} className="canvas-wrapper" />
            <video ref={videoRef} style={{ display: 'none' }} playsInline />

            {loading && (
                <div className="loading-overlay">
                    <div className="loader"></div>
                    <p>SYSTEM INITIALIZING...</p>
                    <small>Accessing Neural Link (Camera)</small>
                </div>
            )}

            <div className="ui-layer">
                <div className="header">
                    <h1>KEPLER-SATURN</h1>
                    <div className="status">
                        <span className="dot"></span> LIVE TRACKING
                    </div>
                </div>

                <button className="fullscreen-btn" onClick={toggleFullscreen}>
                    {isFullscreen ? 'EXIT FULLSCREEN' : 'ENTER IMMERSION'}
                </button>
            </div>
        </div>
    );
}

export default App;