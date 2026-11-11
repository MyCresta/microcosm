// Shared GLSL snippets and a helper that grafts procedural shading onto
// MeshStandardMaterial, so everything keeps PBR lighting and shadows.

export const NOISE = /* glsl */ `
float hash21(vec2 p){ vec3 p3=fract(vec3(p.xyx)*.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
vec2 hash22(vec2 p){ vec3 p3=fract(vec3(p.xyx)*vec3(.1031,.1030,.0973)); p3+=dot(p3,p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
float hash31(vec3 p3){ p3=fract(p3*.1031); p3+=dot(p3,p3.zyx+31.32); return fract((p3.x+p3.y)*p3.z); }
vec3 hash33(vec3 p3){ p3=fract(p3*vec3(.1031,.1030,.0973)); p3+=dot(p3,p3.yxz+33.33); return fract((p3.xxy+p3.yxx)*p3.zyx); }
float vnoise(vec3 p){
  vec3 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(mix(hash31(i),hash31(i+vec3(1,0,0)),f.x),mix(hash31(i+vec3(0,1,0)),hash31(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash31(i+vec3(0,0,1)),hash31(i+vec3(1,0,1)),f.x),mix(hash31(i+vec3(0,1,1)),hash31(i+vec3(1,1,1)),f.x),f.y),f.z);
}
// value noise that fades to grey once it is finer than a pixel, so distant detail does not shimmer
float dnoise(vec3 p, float f){ float w=length(fwidth(p))*f; return mix(vnoise(p*f), 0.5, smoothstep(0.4,1.1,w)); }
float fbm(vec3 p){ float a=.5,s=0.; for(int i=0;i<4;i++){ s+=a*vnoise(p); p=p*2.03+17.1; a*=.5; } return s; }
// x: F1, y: F2, z/w: two random values for the nearest cell
vec4 voro3(vec3 p){
  vec3 i=floor(p), f=fract(p); float d1=8., d2=8.; vec3 id=vec3(0.);
  for(int x=-1;x<=1;x++) for(int y=-1;y<=1;y++) for(int z=-1;z<=1;z++){
    vec3 g=vec3(float(x),float(y),float(z)); vec3 r=g+hash33(i+g)-f; float d=dot(r,r);
    if(d<d1){ d2=d1; d1=d; id=i+g; } else if(d<d2){ d2=d; }
  }
  return vec4(sqrt(d1), sqrt(d2), hash31(id), hash31(id+7.31));
}
`;

// Derivative-based bump mapping from a procedural height value.
export const BUMP = /* glsl */ `
vec3 bumpN(vec3 N, float h, float strength){
  vec3 dpdx=dFdx(-vViewPosition), dpdy=dFdy(-vViewPosition);
  float dhdx=dFdx(h), dhdy=dFdy(h);
  vec3 r1=cross(dpdy,N), r2=cross(N,dpdx);
  float det=dot(dpdx,r1);
  vec3 g=sign(det)*(dhdx*r1+dhdy*r2);
  return normalize(abs(det)*N - strength*g);
}
`;

const VARY = 'varying vec3 vPos; varying vec3 vWN; varying vec3 vOrigin; varying vec3 vLPos;\n';

/**
 * Extend a MeshStandardMaterial with custom chunks.
 * o: { vertPars, vert, fragPars, fragStart, color, rough, normal, emissive }
 */
export function patchStandard(mat, key, o, uniforms = {}) {
  mat.customProgramCacheKey = () => key;
  mat.onBeforeCompile = (sh) => {
    for (const k in uniforms) sh.uniforms[k] = uniforms[k];
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${VARY}${o.vertPars || ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
${o.vert || ''}
vPos = transformed;
#ifdef USE_INSTANCING
  vOrigin = instanceMatrix[3].xyz;
  vWN = normalize(mat3(instanceMatrix) * objectNormal);
  vLPos = (instanceMatrix * vec4(transformed, 1.0)).xyz;
#else
  vOrigin = vec3(0.0); vWN = objectNormal; vLPos = transformed;
#endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${VARY}${NOISE}${BUMP}${o.fragPars || ''}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${o.fragStart || ''}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${o.color || ''}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${o.rough || ''}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${o.normal || ''}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${o.emissive || ''}`);
  };
  return mat;
}

/** Same vertex deformation for a depth material, so shadows match. */
export function patchDepth(mat, key, o, uniforms = {}) {
  mat.customProgramCacheKey = () => key;
  mat.onBeforeCompile = (sh) => {
    for (const k in uniforms) sh.uniforms[k] = uniforms[k];
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${o.vertPars || ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${o.vert || ''}`);
  };
  return mat;
}
