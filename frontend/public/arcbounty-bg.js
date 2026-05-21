// =====================================================================
// ArcBounty — sunrise WebGL background (mode 4: layered ridges, no disc)
// Expects <canvas id="bg"> in the document.
// Optional: #dawnFill, #dawnKnob for the right-edge progress indicator.
// =====================================================================
(() => {
  const VS = `
    attribute vec2 a_pos;
    void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }
  `;
  const FS = `
    precision highp float;
    uniform vec2  u_res;
    uniform vec2  u_mouse;
    uniform float u_time;
    uniform float u_scroll;

    float hash(float x){ return fract(sin(x*127.1)*43758.5453); }
    float noise(float x){
      float i=floor(x), f=fract(x);
      float a=hash(i), b=hash(i+1.0);
      float u=f*f*(3.0-2.0*f);
      return mix(a,b,u);
    }
    float fbm(float x){
      float v=0., a=0.5;
      for(int i=0;i<5;i++){ v+=a*noise(x); x*=2.03; a*=0.5; }
      return v;
    }
    float hash2(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }

    float ridge(float x, float seed, float scale){
      return (fbm(x*scale + seed) - 0.5);
    }

    void main(){
      vec2 p = (gl_FragCoord.xy - 0.5*u_res.xy)/u_res.y;
      vec2 sun = vec2((u_mouse.x-0.5)*0.18, mix(-0.42, 0.55, u_scroll));

      // sky — cool blues top → mid, warm only at horizon (no purples/pinks)
      float y = clamp(p.y*1.2+0.5, 0.0, 1.0);
      vec3 top   = mix(vec3(0.012,0.022,0.065), vec3(0.05,0.16,0.38), u_scroll);
      vec3 mid   = mix(vec3(0.030,0.065,0.165), vec3(0.30,0.55,0.82), u_scroll);
      vec3 horiz = mix(vec3(0.100,0.085,0.130), vec3(1.00,0.78,0.45), u_scroll);
      vec3 col = mix(horiz, mid, smoothstep(0.05, 0.40, y));
      col = mix(col, top, smoothstep(0.40, 0.95, y));

      // warm sunrise glow only — no disc (hidden behind UI anyway)
      vec2 d = p - sun;
      float r = length(d);
      vec3 warm = mix(vec3(0.90,0.42,0.12), vec3(1.00,0.82,0.48), u_scroll);
      col += warm * (exp(-r*3.0)*0.55 + exp(-r*1.1)*0.22);

      // mountains — 4 layers
      float mouseShift = (u_mouse.x - 0.5) * 0.15;
      float yFar  = -0.05 + 0.16*ridge(p.x + mouseShift*0.05, 13.0, 1.4);
      float yMid  = -0.18 + 0.18*ridge(p.x + mouseShift*0.10, 27.0, 2.0);
      float yNear = -0.32 + 0.20*ridge(p.x + mouseShift*0.20, 41.0, 2.6);
      float yFG   = -0.46 + 0.22*ridge(p.x + mouseShift*0.35, 59.0, 3.5);

      vec3 ridgeFar  = mix(vec3(0.06,0.10,0.18),  vec3(0.22,0.36,0.54),  u_scroll) * 0.85;
      vec3 ridgeMid  = mix(vec3(0.04,0.07,0.14),  vec3(0.12,0.22,0.38),  u_scroll) * 0.75;
      vec3 ridgeNear = mix(vec3(0.025,0.045,0.10),vec3(0.06,0.13,0.24),  u_scroll) * 0.65;
      vec3 ridgeFG   = mix(vec3(0.010,0.020,0.06),vec3(0.03,0.07,0.15),  u_scroll) * 0.55;

      if(p.y < yFar)  col = ridgeFar;
      if(p.y < yMid)  col = ridgeMid;
      if(p.y < yNear) col = ridgeNear;
      if(p.y < yFG)   col = ridgeFG;

      // rim light on far ridge
      float rimFar = smoothstep(0.004, 0.0, abs(p.y - yFar));
      col += warm * rimFar * 0.35 * smoothstep(-0.2, 0.1, sun.y);

      // horizon haze
      float haze = exp(-pow((p.y + 0.05)*8.0, 2.0)) * 0.5;
      col += warm * haze * 0.18;

      // night stars
      float starMask = step(0.997, hash2(floor(gl_FragCoord.xy*1.4)));
      col += vec3(0.8,0.85,1.0) * starMask * (1.0 - u_scroll) * smoothstep(0.0, 0.4, p.y) * 0.6;

      col *= 1.0 - 0.42*pow(length(p)*0.9, 2.0);
      gl_FragColor = vec4(col, 1.0);
    }
  `;

  const canvas = document.getElementById('bg');
  if(!canvas){ return; }
  const gl = canvas.getContext('webgl', { antialias: false, premultipliedAlpha: false });
  if(!gl){
    document.body.style.background = 'linear-gradient(to bottom, #050913, #1c2a44 60%, #f9c277)';
    return;
  }
  function compile(type, src){
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s));
    return s;
  }
  const vs = compile(gl.VERTEX_SHADER, VS);
  const fs = compile(gl.FRAGMENT_SHADER, FS);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs); gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if(!gl.getProgramParameter(prog, gl.LINK_STATUS)) console.error(gl.getProgramInfoLog(prog));

  const loc = {
    a_pos:    gl.getAttribLocation(prog, 'a_pos'),
    u_res:    gl.getUniformLocation(prog, 'u_res'),
    u_mouse:  gl.getUniformLocation(prog, 'u_mouse'),
    u_time:   gl.getUniformLocation(prog, 'u_time'),
    u_scroll: gl.getUniformLocation(prog, 'u_scroll'),
  };
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);

  let mouse = { x: 0.5, y: 0.5 };
  let target = { x: 0.5, y: 0.5 };
  let scrollProg = 0, scrollTarget = 0;
  const start = performance.now();

  function resize(){
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(window.innerWidth * dpr);
    const h = Math.floor(window.innerHeight * dpr);
    if(canvas.width !== w || canvas.height !== h){
      canvas.width = w; canvas.height = h;
    }
    gl.viewport(0,0,canvas.width,canvas.height);
  }
  window.addEventListener('resize', resize);
  resize();

  window.addEventListener('mousemove', e => {
    target.x = e.clientX / window.innerWidth;
    target.y = 1.0 - e.clientY / window.innerHeight;
  });

  const dawnFill = document.getElementById('dawnFill');
  const dawnKnob = document.getElementById('dawnKnob');
  function computeScroll(){
    const max = Math.max(1, document.body.scrollHeight - window.innerHeight);
    scrollTarget = Math.min(1, Math.max(0, window.scrollY / max));
  }
  window.addEventListener('scroll', computeScroll, { passive: true });
  computeScroll();

  // If the page is so short there's no scrolling possible, drift the sun to
  // a pleasant mid-morning position so the background isn't pitch-black.
  function ensureMinScroll(){
    if(document.body.scrollHeight <= window.innerHeight + 4){
      scrollTarget = Math.max(scrollTarget, 0.45);
    }
  }
  ensureMinScroll();
  window.addEventListener('resize', ensureMinScroll);

  function frame(){
    resize();
    const t = (performance.now() - start)/1000;
    mouse.x += (target.x - mouse.x) * 0.14;
    mouse.y += (target.y - mouse.y) * 0.14;
    scrollProg += (scrollTarget - scrollProg) * 0.10;

    if(dawnFill && dawnKnob){
      const pct = Math.round(scrollProg*100);
      dawnFill.style.height = pct + '%';
      dawnKnob.style.bottom = pct + '%';
    }

    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(loc.a_pos);
    gl.vertexAttribPointer(loc.a_pos, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(loc.u_res, canvas.width, canvas.height);
    gl.uniform2f(loc.u_mouse, mouse.x, mouse.y);
    gl.uniform1f(loc.u_time, t);
    gl.uniform1f(loc.u_scroll, scrollProg);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
