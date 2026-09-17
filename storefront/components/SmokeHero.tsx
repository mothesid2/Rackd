'use client';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';

const COUNT = 9;
const BASE_SIZE = 220;    
const GROWTH = 3;         
const PEAK_OPACITY = 0.1;
const TURBULENCE_STRENGTH = 18;

interface Wisp {
  x: number; y: number; z: number; vy: number;
  life: number; maxLife: number;
}

const VERTEX_SHADER =  `
  attribute vec3 instancePosition;
  attribute float instanceSize;
  attribute float instanceOpacity;
  varying vec2 vUv;
  varying float vOpacity;
  void main() {
    vUv = uv;
    vOpacity = instanceOpacity;
    // Billboard: reconstruct the camera's right/up axes from the view
    // matrix so this instanced quad always faces the camera, same as a
    // THREE.Sprite would, but across every instance in one draw call.
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vec3 worldPos = instancePosition + (right * position.x + up * position.y) * instanceSize;
    gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
  }
`;
const FRAGMENT_SHADER =  `
  uniform sampler2D map;
  uniform vec3 color;
  varying vec2 vUv;
  varying float vOpacity;
  void main() {
    float a = texture2D(map, vUv).a;
    gl_FragColor = vec4(color, a * vOpacity);
  }
`;


export function SmokeHero({ className }: { className?: string }) {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const noise2D = createNoise2D();

    let width = mount.clientWidth;
    let height = mount.clientHeight;

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height);
    
    
    
    
    renderer.setClearColor(0x000000, 0);
    
    
    
    
    const maskImage =
      'linear-gradient(to bottom, transparent 0%, black 12%, black 78%, transparent 100%), ' +
      'linear-gradient(to right, transparent 0%, black 8%, black 92%, transparent 100%)';
    renderer.domElement.style.maskImage = maskImage;
    renderer.domElement.style.webkitMaskImage = maskImage;
    renderer.domElement.style.maskComposite = 'intersect';
    (renderer.domElement.style as any).webkitMaskComposite = 'source-in';
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    
    
    
    
    const camera = new THREE.OrthographicCamera(-width / 2, width / 2, height / 2, -height / 2, 0.1, 100);
    camera.position.z = 10;

    
    
    
    
    
    
    const texture = makeSmokeTexture();
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;

    function makeSmokeTexture(size = 512): THREE.CanvasTexture {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const cctx = c.getContext('2d')!;
      for (let i = 0; i < 20; i++) {
        const x = size * 0.2 + Math.random() * size * 0.6;
        const y = size * 0.2 + Math.random() * size * 0.6;
        const r = size * 0.15 + Math.random() * size * 0.2;
        const g = cctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, 'rgba(255,255,255,0.4)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        cctx.fillStyle = g;
        cctx.fillRect(0, 0, size, size);
      }
      
      
      cctx.globalCompositeOperation = 'destination-out';
      const centerFade = cctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size * 0.3);
      centerFade.addColorStop(0, 'rgba(0,0,0,0.5)');
      centerFade.addColorStop(1, 'rgba(0,0,0,0)');
      cctx.fillStyle = centerFade;
      cctx.fillRect(0, 0, size, size);

      
      
      
      
      
      
      
      
      
      cctx.globalCompositeOperation = 'destination-in';
      const edgeMask = cctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      edgeMask.addColorStop(0, 'rgba(255,255,255,1)');
      edgeMask.addColorStop(0.65, 'rgba(255,255,255,1)');
      edgeMask.addColorStop(1, 'rgba(255,255,255,0)');
      cctx.fillStyle = edgeMask;
      cctx.fillRect(0, 0, size, size);

      return new THREE.CanvasTexture(c);
    }

    
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.instanceCount = COUNT;
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ]), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    geometry.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));

    const instancePosition = new THREE.InstancedBufferAttribute(new Float32Array(COUNT * 3), 3);
    const instanceSize = new THREE.InstancedBufferAttribute(new Float32Array(COUNT), 1);
    const instanceOpacity = new THREE.InstancedBufferAttribute(new Float32Array(COUNT), 1);
    geometry.setAttribute('instancePosition', instancePosition);
    geometry.setAttribute('instanceSize', instanceSize);
    geometry.setAttribute('instanceOpacity', instanceOpacity);

    const material = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: texture },
        color: { value: new THREE.Color('rgb(226,221,216)') },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      blending: THREE.NormalBlending,
      depthWrite: false,
      depthTest: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);

    function spawn(randomizeAge: boolean): Wisp {
      const w: Wisp = {
        x: width * (0.1 + Math.random() * 0.8),
        y: height + 40,
        z: 0,
        vy: -(0.18 + Math.random() * 0.22),
        life: 0,
        maxLife: 620 + Math.random() * 380,
      };
      if (randomizeAge) { w.life = Math.random() * w.maxLife; w.y = height - w.life * -w.vy; }
      return w;
    }
    const wisps: Wisp[] = Array.from({ length: COUNT }, () => spawn(true));

    function resize() {
      const w = mount!.clientWidth, h = mount!.clientHeight;
      if (w === 0 || h === 0 || (w === width && h === height)) return;
      const wasUnsized = width === 0 || height === 0;
      width = w; height = h;
      renderer.setSize(width, height);
      camera.left = -width / 2; camera.right = width / 2;
      camera.top = height / 2; camera.bottom = -height / 2;
      camera.updateProjectionMatrix();
      
      
      
      if (wasUnsized) wisps.forEach((_, i) => Object.assign(wisps[i], spawn(true)));
    }
    
    
    
    
    
    
    const ro = new ResizeObserver(resize);
    ro.observe(mount);
    window.addEventListener('resize', resize);

    let raf = 0;
    let clock = 0; 
    function frame() {
      clock += 1 / 60;
      for (let i = 0; i < wisps.length; i++) {
        const w = wisps[i];
        w.life += 1;
        w.y += w.vy;

        
        
        
        
        
        
        
        
        const nx = noise2D(w.y * 0.1, clock);
        const nz = noise2D(w.y * 0.1 + 100, clock);
        w.x += nx * TURBULENCE_STRENGTH * (1 / 60);
        w.z += nz * TURBULENCE_STRENGTH * (1 / 60);

        const t = w.life / w.maxLife;
        const fade = t < 0.12 ? t / 0.12 : t > 0.7 ? Math.max(0, 1 - (t - 0.7) / 0.3) : 1;
        
        
        const size = BASE_SIZE * (1 + (GROWTH - 1) * t);

        if (w.life >= w.maxLife || w.y < -size) Object.assign(w, spawn(false));

        
        
        
        
        const depthWobble = 1 + w.z * 0.0006;

        instancePosition.setXYZ(i, w.x - width / 2, height / 2 - w.y, w.z);
        instanceSize.setX(i, size * depthWobble);
        instanceOpacity.setX(i, PEAK_OPACITY * fade * depthWobble);
      }
      instancePosition.needsUpdate = true;
      instanceSize.needsUpdate = true;
      instanceOpacity.needsUpdate = true;

      renderer.render(scene, camera);
      if (!reduced) raf = requestAnimationFrame(frame);
    }
    frame();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      ro.disconnect();
      geometry.dispose();
      material.dispose();
      texture.dispose();
      renderer.dispose();
      mount!.removeChild(renderer.domElement);
    };
  }, []);

  return <div ref={mountRef} className={className} aria-hidden="true" />;
}
