/**
 * High-DPI WebGL2 3D spaceflight renderer for #aura.
 * - Dynamic multi-tone cosmic nebula glow
 * - True 3D perspective starfield (spectral colors + sub-pixel AA)
 */

const NEBULA_VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const NEBULA_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform float u_time;
uniform float u_seed;
uniform vec2 u_res;
out vec4 fragColor;

// Cosine color palette for smooth, ever-changing cosmic harmonies
vec3 palette(float t) {
  vec3 a = vec3(0.42, 0.44, 0.58);
  vec3 b = vec3(0.36, 0.34, 0.38);
  vec3 c = vec3(1.0, 1.0, 1.0);
  vec3 d = vec3(0.05, 0.28, 0.62) + vec3(u_seed * 0.17, u_seed * 0.31, u_seed * 0.47);
  return a + b * cos(6.28318 * (c * t + d));
}

void main() {
  vec2 uv = v_uv;
  float aspect = u_res.x / max(u_res.y, 1.0);
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  float t = u_time * 0.075 + u_seed;

  vec2 c1 = vec2(sin(t * 0.7) * 0.55, cos(t * 0.5) * 0.32);
  vec2 c2 = vec2(cos(t * 0.6 + 2.1) * 0.62, sin(t * 0.8 + 1.3) * 0.36);
  vec2 c3 = vec2(sin(t * 0.45 + 4.2) * 0.48, cos(t * 0.65 + 3.4) * 0.28);

  float g1 = exp(-dot(p - c1, p - c1) * 2.6);
  float g2 = exp(-dot(p - c2, p - c2) * 3.1);
  float g3 = exp(-dot(p - c3, p - c3) * 3.8);

  vec3 col1 = palette(u_time * 0.012);
  vec3 col2 = palette(u_time * 0.012 + 0.33);
  vec3 col3 = palette(u_time * 0.012 + 0.67);

  vec3 glow = col1 * g1 * 0.55 + col2 * g2 * 0.48 + col3 * g3 * 0.42;
  float alpha = clamp((g1 * 0.12 + g2 * 0.10 + g3 * 0.09), 0.0, 0.22);
  fragColor = vec4(glow, alpha);
}`;

const STAR_VS = `#version 300 es
in vec4 a_star; // x, y, z, colorSeed
uniform float u_time;
uniform float u_dpr;
uniform vec2 u_res;
out float v_alpha;
out vec3 v_col;
void main() {
  float z = fract(a_star.z - u_time * 0.070);
  z = 0.06 + z * 0.94;
  vec2 p = a_star.xy / z;
  gl_Position = vec4(p.x, p.y * (u_res.x / u_res.y) + 0.06, 0.0, 1.0);
  float size = mix(2.6, 0.7, z) * u_dpr;
  gl_PointSize = size;
  float fadeIn = smoothstep(1.0, 0.78, z);
  float fadeOut = smoothstep(0.06, 0.18, z);
  float twinkle = 0.82 + 0.18 * sin(u_time * 2.1 + a_star.w * 40.0);
  v_alpha = fadeIn * fadeOut * twinkle * 0.85;
  // Spectral star tint: cool blue-white, pure white, warm gold
  float s = a_star.w;
  v_col = s < 0.35 ? vec3(0.72, 0.85, 1.0) : s < 0.75 ? vec3(0.96, 0.97, 1.0) : vec3(1.0, 0.88, 0.72);
}`;

const STAR_FS = `#version 300 es
precision highp float;
in float v_alpha;
in vec3 v_col;
out vec4 fragColor;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = smoothstep(1.0, 0.15, d) * v_alpha;
  if (a < 0.005) discard;
  fragColor = vec4(v_col, a);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

function link(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

export function initCosmos(canvas) {
  if (!canvas) return;
  const gl = canvas.getContext("webgl2", { alpha: true, antialias: true, powerPreference: "low-power" });
  if (!gl) return;

  let nebProg, starProg;
  try {
    nebProg = link(gl, NEBULA_VS, NEBULA_FS);
    starProg = link(gl, STAR_VS, STAR_FS);
  } catch {
    return;
  }
  const sessionSeed = Math.random() * 100;

  // Deterministic 3D starfield (220 spectral stars)
  const starCount = 220;
  const starData = new Float32Array(starCount * 4);
  let seed = 1337;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  for (let i = 0; i < starCount; i++) {
    const angle = rand() * Math.PI * 2;
    const dist = 0.08 + Math.pow(rand(), 0.7) * 0.85;
    starData[i * 4 + 0] = Math.cos(angle) * dist;
    starData[i * 4 + 1] = Math.sin(angle) * dist;
    starData[i * 4 + 2] = rand();
    starData[i * 4 + 3] = rand();
  }

  const starBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, starBuf);
  gl.bufferData(gl.ARRAY_BUFFER, starData, gl.STATIC_DRAW);

  const quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

  const locNeb = gl.getAttribLocation(nebProg, "a_pos");
  const uNebTime = gl.getUniformLocation(nebProg, "u_time");
  const uNebSeed = gl.getUniformLocation(nebProg, "u_seed");
  const uNebRes = gl.getUniformLocation(nebProg, "u_res");

  const locStar = gl.getAttribLocation(starProg, "a_star");
  const uStarTime = gl.getUniformLocation(starProg, "u_time");
  const uStarDpr = gl.getUniformLocation(starProg, "u_dpr");
  const uStarRes = gl.getUniformLocation(starProg, "u_res");

  const calm = matchMedia("(prefers-reduced-motion: reduce)");
  let w = 0, h = 0, dpr = 1, raf = 0;

  const resize = () => {
    dpr = Math.min(devicePixelRatio || 1, 3);
    w = Math.max(1, Math.floor(innerWidth * dpr));
    h = Math.max(1, Math.floor(innerHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  };
  resize();
  addEventListener("resize", resize);

  const shouldPause = () =>
    document.hidden || calm.matches || document.documentElement.dataset.theme === "light";

  const frame = (now) => {
    raf = 0;

    if (shouldPause()) {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }

    resize();
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const t = now * 0.001;

    // 0. Dynamic multi-tone cosmic nebula glow
    gl.useProgram(nebProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.enableVertexAttribArray(locNeb);
    gl.vertexAttribPointer(locNeb, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1f(uNebTime, t);
    gl.uniform1f(uNebSeed, sessionSeed);
    gl.uniform2f(uNebRes, w, h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 1. Crisp 3D starfield
    gl.useProgram(starProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, starBuf);
    gl.enableVertexAttribArray(locStar);
    gl.vertexAttribPointer(locStar, 4, gl.FLOAT, false, 0, 0);
    gl.uniform1f(uStarTime, t);
    gl.uniform1f(uStarDpr, dpr);
    gl.uniform2f(uStarRes, w, h);
    gl.drawArrays(gl.POINTS, 0, starCount);

    raf = requestAnimationFrame(frame);
  };

  const kick = () => {
    if (!raf && !shouldPause()) {
      raf = requestAnimationFrame(frame);
    }
  };

  document.addEventListener("visibilitychange", kick);
  calm.addEventListener?.("change", kick);
  new MutationObserver(kick).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  kick();
}
