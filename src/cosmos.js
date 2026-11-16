/**
 * WebGL2 3D planet cruise renderer for #aura.
 * Renders 5 small, 3D-shaded rotating planets (Earth, Saturn with 3D ring, Mars, Jupiter, Neptune)
 * gliding forward in perspective depth behind the deck.
 */

const VS = `#version 300 es
in vec2 a_pos;
uniform vec2 u_center;
uniform vec2 u_radius;
out vec2 v_uv;
void main() {
  v_uv = a_pos;
  gl_Position = vec4(u_center + a_pos * u_radius, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform int u_kind;
uniform float u_spin;
uniform float u_tilt;
uniform float u_alpha;
uniform float u_hasRing;
out vec4 fragColor;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float noise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x),
        mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
        mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y),
    f.z
  );
}

float fbm(vec3 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = p * 2.05 + vec3(1.7, 9.2, 3.4);
    a *= 0.5;
  }
  return v;
}

mat3 rotY(float a) {
  float c = cos(a), s = sin(a);
  return mat3(c, 0.0, s, 0.0, 1.0, 0.0, -s, 0.0, c);
}

mat3 rotX(float a) {
  float c = cos(a), s = sin(a);
  return mat3(1.0, 0.0, 0.0, 0.0, c, -s, 0.0, s, c);
}

vec3 shadePlanet(vec3 n, vec3 lightDir) {
  vec3 p = rotY(u_spin) * (rotX(u_tilt) * n);
  float diff = max(dot(n, lightDir), 0.0);
  float rim = pow(1.0 - max(n.z, 0.0), 3.0);
  vec3 albedo = vec3(0.5);
  vec3 atmo = vec3(0.5, 0.7, 1.0);

  if (u_kind == 0) {
    // Earth-like: oceans, continents, clouds
    float cont = fbm(p * 2.4);
    float land = smoothstep(0.49, 0.55, cont);
    vec3 sea = mix(vec3(0.06, 0.19, 0.44), vec3(0.10, 0.34, 0.62), fbm(p * 4.5));
    vec3 ground = mix(vec3(0.16, 0.42, 0.24), vec3(0.58, 0.50, 0.34), smoothstep(0.55, 0.78, cont));
    albedo = mix(sea, ground, land);
    float clouds = smoothstep(0.54, 0.72, fbm(p * 3.2 + vec3(u_spin * 0.25, 0.0, 0.0)));
    albedo = mix(albedo, vec3(0.95, 0.97, 1.0), clouds * 0.68);
    atmo = vec3(0.38, 0.68, 1.0);
  } else if (u_kind == 1) {
    // Saturn-like: golden cream bands
    float turb = fbm(p * 4.0) * 0.16;
    float bands = sin((p.y + turb) * 18.0) * 0.5 + 0.5;
    albedo = mix(vec3(0.68, 0.58, 0.42), vec3(0.92, 0.84, 0.66), bands);
    atmo = vec3(0.95, 0.84, 0.62);
  } else if (u_kind == 2) {
    // Mars-like: rusty terrain, basaltic plains, polar cap
    float h = fbm(p * 3.1);
    albedo = mix(vec3(0.38, 0.15, 0.10), vec3(0.82, 0.42, 0.23), smoothstep(0.32, 0.68, h));
    float ice = smoothstep(0.84, 0.92, abs(p.y) + h * 0.08);
    albedo = mix(albedo, vec3(0.94, 0.92, 0.90), ice);
    atmo = vec3(0.95, 0.55, 0.36);
  } else if (u_kind == 3) {
    // Jupiter-like: turbulent bands + storm spot
    float turb = fbm(p * 3.8) * 0.22;
    float band = sin((p.y + turb) * 15.0) * 0.5 + 0.5;
    albedo = mix(vec3(0.64, 0.42, 0.28), vec3(0.92, 0.86, 0.76), band);
    float spot = length((p.xy - vec2(0.35, -0.22)) * vec2(1.0, 1.8));
    if (p.z > 0.0) albedo = mix(albedo, vec3(0.82, 0.36, 0.22), smoothstep(0.22, 0.06, spot) * 0.85);
    atmo = vec3(0.94, 0.76, 0.56);
  } else {
    // Neptune-like: deep azure + methane streaks
    float streak = fbm(vec3(p.x * 1.4, p.y * 6.0, p.z * 1.4));
    albedo = mix(vec3(0.08, 0.22, 0.62), vec3(0.28, 0.62, 0.95), smoothstep(0.35, 0.75, streak));
    atmo = vec3(0.40, 0.76, 1.0);
  }

  vec3 lit = albedo * (0.06 + 0.98 * diff);
  lit += atmo * rim * (0.28 + 0.55 * diff);
  return lit;
}

void main() {
  // Quad spans [-2.4, 2.4] so rings fit cleanly outside the unit sphere
  vec2 q = v_uv * 2.4;
  vec3 ro = vec3(q, 3.5);
  vec3 rd = vec3(0.0, 0.0, -1.0);
  vec3 lightDir = normalize(vec3(-0.65, 0.48, 0.58));

  // Ray-sphere intersection (unit sphere at origin)
  float b = dot(ro, rd);
  float c = dot(ro, ro) - 1.0;
  float disc = b * b - c;
  bool hitSphere = disc >= 0.0;
  float tSphere = hitSphere ? (-b - sqrt(disc)) : 1e9;

  // Ray-ring-plane intersection (tilted plane through origin)
  vec4 ringCol = vec4(0.0);
  float tRing = 1e9;
  if (u_hasRing > 0.5) {
    vec3 ringN = normalize(rotX(1.18) * rotY(0.28) * vec3(0.0, 1.0, 0.0));
    float denom = dot(rd, ringN);
    if (abs(denom) > 0.001) {
      float tr = -dot(ro, ringN) / denom;
      vec3 hr = ro + rd * tr;
      float r = length(hr);
      if (r > 1.32 && r < 2.25) {
        tRing = tr;
        float band = sin(r * 34.0) * 0.5 + 0.5;
        float gap = smoothstep(0.04, 0.09, abs(r - 1.82));
        float fade = smoothstep(1.32, 1.44, r) * (1.0 - smoothstep(2.08, 2.25, r));
        float shadow = 1.0;
        // Planet shadow on ring
        float sb = dot(hr, lightDir);
        vec3 closest = hr - lightDir * sb;
        if (sb < 0.0 && length(closest) < 1.0) shadow = 0.18;
        vec3 rc = mix(vec3(0.68, 0.60, 0.48), vec3(0.92, 0.86, 0.72), band) * shadow;
        ringCol = vec4(rc, fade * gap * 0.72);
      }
    }
  }

  vec4 outCol = vec4(0.0);
  if (hitSphere) {
    vec3 hit = ro + rd * tSphere;
    vec3 col = shadePlanet(normalize(hit), lightDir);
    float edge = smoothstep(0.0, 0.05, sqrt(disc));
    outCol = vec4(col, edge);
  }

  // Composite ring behind or in front of sphere by depth
  if (ringCol.a > 0.01) {
    if (tRing < tSphere) {
      outCol.rgb = mix(outCol.rgb, ringCol.rgb, ringCol.a);
      outCol.a = max(outCol.a, ringCol.a);
    } else if (!hitSphere || outCol.a < 0.99) {
      outCol.rgb = mix(ringCol.rgb, outCol.rgb, outCol.a);
      outCol.a = max(outCol.a, ringCol.a);
    }
  }

  if (outCol.a < 0.004) discard;
  fragColor = vec4(outCol.rgb, outCol.a * u_alpha);
}`;

// 5 planets spaced by 0.48 along a 2.40 depth cycle (visible in 0.08..1.0 -> always 1–2 on screen).
const PLANETS = [
  { kind: 1, hasRing: true,  radius: 17, dx: 0.42,  dy: -0.24, z: 0.30, speed: 0.020, spin: 0.28, tilt: 0.35 },
  { kind: 0, hasRing: false, radius: 14, dx: -0.44, dy: 0.22,  z: 0.78, speed: 0.020, spin: 0.34, tilt: 0.41 },
  { kind: 2, hasRing: false, radius: 11, dx: -0.35, dy: -0.27, z: 1.26, speed: 0.020, spin: 0.24, tilt: 0.44 },
  { kind: 3, hasRing: false, radius: 16, dx: 0.38,  dy: 0.27,  z: 1.74, speed: 0.020, spin: 0.40, tilt: 0.06 },
  { kind: 4, hasRing: false, radius: 12, dx: 0.08,  dy: -0.36, z: 2.22, speed: 0.020, spin: 0.30, tilt: 0.48 },
];

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

export function initCosmos(canvas) {
  if (!canvas) return;
  const gl = canvas.getContext("webgl2", { alpha: true, antialias: true, powerPreference: "low-power" });
  if (!gl) return;

  let prog;
  try {
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
  } catch {
    return;
  }

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const locPos = gl.getAttribLocation(prog, "a_pos");
  gl.enableVertexAttribArray(locPos);
  gl.vertexAttribPointer(locPos, 2, gl.FLOAT, false, 0, 0);

  const uCenter = gl.getUniformLocation(prog, "u_center");
  const uRadius = gl.getUniformLocation(prog, "u_radius");
  const uKind = gl.getUniformLocation(prog, "u_kind");
  const uSpin = gl.getUniformLocation(prog, "u_spin");
  const uTilt = gl.getUniformLocation(prog, "u_tilt");
  const uAlpha = gl.getUniformLocation(prog, "u_alpha");
  const uHasRing = gl.getUniformLocation(prog, "u_hasRing");

  const calm = matchMedia("(prefers-reduced-motion: reduce)");
  let w = 0, h = 0, raf = 0, last = performance.now();

  const resize = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
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
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;

    if (shouldPause()) {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(prog);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const dpr = Math.min(devicePixelRatio || 1, 2);
    const t = now * 0.001;

    for (const p of PLANETS) {
      p.z -= p.speed * dt;
      if (p.z < 0.08) p.z += 2.40;
      if (p.z > 1.0) continue;

      // Perspective projection from center (0, 0.08 in NDC)
      const progZ = 1.0 - p.z; // 0 = far, 0.92 = near
      const cx = (p.dx * progZ * 2.1);
      const cy = 0.08 + (p.dy * progZ * -2.1);
      const scale = 0.25 + progZ * 1.45;
      const radPx = p.radius * scale * 2.4 * dpr;

      const fadeIn = Math.min(1, (1.0 - p.z) / 0.18);
      const fadeOut = Math.min(1, (p.z - 0.08) / 0.14);
      const alpha = Math.max(0, Math.min(fadeIn, fadeOut)) * 0.92;

      gl.uniform2f(uCenter, cx, cy);
      gl.uniform2f(uRadius, (radPx / w) * 2.0, (radPx / h) * 2.0);
      gl.uniform1i(uKind, p.kind);
      gl.uniform1f(uSpin, t * p.spin);
      gl.uniform1f(uTilt, p.tilt);
      gl.uniform1f(uAlpha, alpha);
      gl.uniform1f(uHasRing, p.hasRing ? 1.0 : 0.0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    raf = requestAnimationFrame(frame);
  };

  const kick = () => {
    if (!raf && !shouldPause()) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  };

  document.addEventListener("visibilitychange", kick);
  calm.addEventListener?.("change", kick);
  new MutationObserver(kick).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  kick();
}
