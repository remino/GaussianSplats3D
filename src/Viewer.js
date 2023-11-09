import * as THREE from 'three';
import { OrbitControls } from './OrbitControls.js';
import { PlyLoader } from './PlyLoader.js';
import { SplatLoader } from './SplatLoader.js';
import { SplatBuffer } from './SplatBuffer.js';
// import { LoadingSpinner } from './LoadingSpinner.js';
import { SceneHelper } from './SceneHelper.js';
import { Raycaster } from './raycaster/Raycaster.js';
import { SplatMesh } from './SplatMesh.js';
import { createSortWorker } from './worker/SortWorker.js';
import { Constants } from './Constants.js';

const THREE_CAMERA_FOV = 60;

export class Viewer {

    constructor(params = {}) {

        if (!params.cameraUp) params.cameraUp = [0, 1, 0];
        if (!params.initialCameraPosition) params.initialCameraPosition = [0, 10, 15];
        if (!params.initialCameraLookAt) params.initialCameraLookAt = [0, 0, 0];
        if (params.selfDrivenMode === undefined) params.selfDrivenMode = true;
        if (params.useBuiltInControls === undefined) params.useBuiltInControls = true;

        this.rootElement = params.rootElement;
        this.usingExternalCamera = params.camera ? true : false;
        this.usingExternalRenderer = params.renderer ? true : false;

        this.cameraUp = new THREE.Vector3().fromArray(params.cameraUp);
        this.initialCameraPosition = new THREE.Vector3().fromArray(params.initialCameraPosition);
        this.initialCameraLookAt = new THREE.Vector3().fromArray(params.initialCameraLookAt);

        this.scene = params.scene;
        this.simpleScene = params.simpleScene;
        this.renderer = params.renderer;
        this.camera = params.camera;
        this.useBuiltInControls = params.useBuiltInControls;
        this.controls = null;
        this.selfDrivenMode = params.selfDrivenMode;
        this.selfDrivenUpdateFunc = this.selfDrivenUpdate.bind(this);
        this.showMeshCursor = false;
        this.showInfo = false;

        this.sceneHelper = null;

        this.sortWorker = null;
        this.splatRenderCount = 0;
        this.splatSortCount = 0;

        this.inIndexArray = null;

        this.splatMesh = null;

        this.sortRunning = false;
        this.selfDrivenModeRunning = false;
        this.splatRenderingInitialized = false;

        this.raycaster = new Raycaster();

        this.infoPanel = null;
        this.infoPanelCells = {};

        this.currentFPS = 0;
        this.lastSortTime = 0;

        this.mousePosition = new THREE.Vector2();
        window.addEventListener('mousemove', this.onMouseMove.bind(this));
        window.addEventListener('keydown', this.onKeyDown.bind(this));
    }

    onKeyDown(e) {
        switch (e.code) {
            case 'KeyC':
                this.showMeshCursor = !this.showMeshCursor;
            break;
            case 'KeyI':
                this.showInfo = !this.showInfo;
                if (this.showInfo) {
                    this.infoPanel.style.display = 'block';
                } else {
                    this.infoPanel.style.display = 'none';
                }
            break;
        }
    }

    onMouseMove(mouse) {
        this.mousePosition.set(mouse.offsetX, mouse.offsetY);
    }

    getRenderDimensions(outDimensions) {
        if (this.rootElement) {
            outDimensions.x = this.rootElement.offsetWidth;
            outDimensions.y = this.rootElement.offsetHeight;
        } else {
            this.renderer.getSize(outDimensions);
        }
    }

    init(docElement) {
        this.docElement = docElement || document.body;
        this.setupInfoPanel();

        if (!this.rootElement && !this.usingExternalRenderer) {
            this.rootElement = document.createElement('div');
            this.rootElement.style.width = '100%';
            this.rootElement.style.height = '100%';
            this.docElement.appendChild(this.rootElement);
        }

        const renderDimensions = new THREE.Vector2();
        this.getRenderDimensions(renderDimensions);

        if (!this.usingExternalCamera) {
            this.camera = new THREE.PerspectiveCamera(THREE_CAMERA_FOV, renderDimensions.x / renderDimensions.y, 0.1, 500);
            this.camera.position.copy(this.initialCameraPosition);
            this.camera.lookAt(this.initialCameraLookAt);
            this.camera.up.copy(this.cameraUp).normalize();
        }

        this.scene = this.scene || new THREE.Scene();
        this.simpleScene = this.simpleScene || new THREE.Scene();
        this.sceneHelper = new SceneHelper(this.scene, this.simpleScene);
        this.sceneHelper.setupMeshCursor();

        if (!this.usingExternalRenderer) {
            this.renderer = new THREE.WebGLRenderer({
                antialias: false,
                precision: 'highp'
            });
            this.renderer.setSize(renderDimensions.x, renderDimensions.y);
        }
        this.setupRenderTargetCopyObjects();

        if (this.useBuiltInControls) {
            this.controls = new OrbitControls(this.camera, this.renderer.domElement);
            this.controls.rotateSpeed = 0.5;
            this.controls.maxPolarAngle = (0.9 * Math.PI) / 2;
            this.controls.enableDamping = true;
            this.controls.dampingFactor = 0.15;
            this.controls.target.copy(this.initialCameraLookAt);
        }

        if (!this.usingExternalRenderer) {
            const resizeObserver = new ResizeObserver(() => {
                this.getRenderDimensions(renderDimensions);
                this.renderer.setSize(renderDimensions.x, renderDimensions.y);
            });
            resizeObserver.observe(this.rootElement);
            this.rootElement.appendChild(this.renderer.domElement);
        }

        this.setupSimpleObjectDepthOverrideMaterial();

    }

    setupInfoPanel() {
        this.infoPanel = document.createElement('div');
        this.infoPanel.style.position = 'absolute';
        this.infoPanel.style.padding = '10px';
        this.infoPanel.style.backgroundColor = '#cccccc';
        this.infoPanel.style.border = '#aaaaaa 1px solid';
        this.infoPanel.style.zIndex = 100;
        this.infoPanel.style.width = '375px';
        this.infoPanel.style.fontFamily = 'arial';
        this.infoPanel.style.fontSize = '10pt';

        const layout = [
            ['Camera position', 'cameraPosition'],
            ['Camera look-at', 'cameraLookAt'],
            ['Cursor position', 'cursorPosition'],
            ['FPS', 'fps'],
            ['Render window', 'renderWindow'],
            ['Rendering:', 'renderSplatCount'],
            ['Sort time', 'sortTime']
        ];

        const infoTable = document.createElement('div');
        infoTable.style.display = 'table';

        for (let layoutEntry of layout) {
            const row = document.createElement('div');
            row.style.display = 'table-row';

            const labelCell = document.createElement('div');
            labelCell.style.display = 'table-cell';
            labelCell.style.width = '110px';
            labelCell.innerHTML = `${layoutEntry[0]}: `;

            const spacerCell = document.createElement('div');
            spacerCell.style.display = 'table-cell';
            spacerCell.style.width = '10px';
            spacerCell.innerHTML = ' ';

            const infoCell = document.createElement('div');
            infoCell.style.display = 'table-cell';
            infoCell.innerHTML = '';

            this.infoPanelCells[layoutEntry[1]] = infoCell;

            row.appendChild(labelCell);
            row.appendChild(spacerCell);
            row.appendChild(infoCell);

            infoTable.appendChild(row);
        }

        this.infoPanel.appendChild(infoTable);
        this.infoPanel.style.display = 'none';
        this.docElement.appendChild(this.infoPanel);
    }

    updateSplatRenderTargetForRenderDimensions(width, height) {
        this.splatRenderTarget = new THREE.WebGLRenderTarget(width, height, {
            format: THREE.RGBAFormat,
            stencilBuffer: false,
            depthBuffer: true,

        });
        this.splatRenderTarget.depthTexture = new THREE.DepthTexture(width, height);
        this.splatRenderTarget.depthTexture.format = THREE.DepthFormat;
        this.splatRenderTarget.depthTexture.type = THREE.UnsignedIntType;
    }

    setupSimpleObjectDepthOverrideMaterial() {
        this.simpleObjectDepthOverrideMaterial = new THREE.ShaderMaterial({
            vertexShader: `
                #include <common>
                void main() {
                    gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position.xyz, 1.0);   
                }
            `,
            fragmentShader: `
                #include <common>
                void main() {
                    gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);
              }
            `,
            depthWrite: true,
            depthTest: true,
            transparent: false
        });
    }

    setupRenderTargetCopyObjects() {
        const uniforms = {
            'sourceColorTexture': {
                'type': 't',
                'value': null
            },
            'sourceDepthTexture': {
                'type': 't',
                'value': null
            },
        };
        this.renderTargetCopyMaterial = new THREE.ShaderMaterial({
            vertexShader: `
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = vec4( position.xy, 0.0, 1.0 );    
                }
            `,
            fragmentShader: `
                #include <common>
                #include <packing>
                varying vec2 vUv;
                uniform sampler2D sourceColorTexture;
                uniform sampler2D sourceDepthTexture;
                void main() {
                    vec4 color = texture2D(sourceColorTexture, vUv);
                    float fragDepth = texture2D(sourceDepthTexture, vUv).x;
                    gl_FragDepth = fragDepth;
                    gl_FragColor = vec4(color.rgb, color.a * 2.0);
              }
            `,
            uniforms: uniforms,
            depthWrite: false,
            depthTest: false,
            transparent: true,
            blending: THREE.CustomBlending,
            blendSrc: THREE.SrcAlphaFactor,
            blendSrcAlpha: THREE.SrcAlphaFactor,
            blendDst: THREE.OneMinusSrcAlphaFactor,
            blendDstAlpha: THREE.OneMinusSrcAlphaFactor
        });
        this.renderTargetCopyMaterial.extensions.fragDepth = true;
        this.renderTargetCopyQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.renderTargetCopyMaterial);
        this.renderTargetCopyCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    }

    updateSplatMeshUniforms = function() {

        const renderDimensions = new THREE.Vector2();

        return function() {
            const splatCount = this.splatMesh.getSplatCount();
            if (splatCount > 0) {
                this.getRenderDimensions(renderDimensions);
                this.cameraFocalLength = (renderDimensions.y / 2.0) / Math.tan(this.camera.fov / 2.0 * THREE.MathUtils.DEG2RAD);
                this.splatMesh.updateUniforms(renderDimensions, this.cameraFocalLength);
            }
        };

    }();

    loadFile(fileName, options = {}) {
        if (options.position) options.position = new THREE.Vector3().fromArray(options.position);
        if (options.orientation) options.orientation = new THREE.Quaternion().fromArray(options.orientation);
        options.attrsTransforms = options.attrsTransforms || [];
        options.splatFilters = options.splatFilters || [];
        options.halfPrecisionCovariances = !!options.halfPrecisionCovariances;
        // const loadingSpinner = new LoadingSpinner();
        // loadingSpinner.show();
        return new Promise((resolve, reject) => {
            let fileLoadPromise;
            if (fileName.endsWith('.splat')) {
                fileLoadPromise = new SplatLoader().loadFromFile(fileName);
            } else if (fileName.endsWith('.ply')) {
                fileLoadPromise = new PlyLoader().loadFromFile(fileName);
            } else {
                reject(new Error(`Viewer::loadFile -> File format not supported: ${fileName}`));
            }
            fileLoadPromise
            .then((splatBuffer) => {
                this.setupSplatMesh(splatBuffer, options.position, options.orientation,
                                    options.splatFilters, options.attrsTransforms, options.halfPrecisionCovariances);
                return this.setupSortWorker(splatBuffer);
            })
            .then(() => {
                this.rootElement.dispatchEvent(
                    new CustomEvent('splatMeshLoaded', {
                        detail: {
                            splatMesh: this.splatMesh
                        }
                    })
                );

                // loadingSpinner.hide();

                resolve();
            })
            .catch((e) => {
                reject(new Error(`Viewer::loadFile -> Could not load file ${fileName}`));
            });
        });
    }

    setupSplatMesh(splatBuffer, position = new THREE.Vector3(), quaternion = new THREE.Quaternion(),
                   splatFilters = [], attrsTransforms = [], halfPrecisionCovariances = false) {
        splatBuffer.optimize(splatFilters, attrsTransforms);
        const splatCount = splatBuffer.getSplatCount();
        console.log(`Splat count: ${splatCount}`);

        splatBuffer.buildPreComputedBuffers();
        this.splatMesh = SplatMesh.buildMesh(splatBuffer, halfPrecisionCovariances);
        this.splatMesh.position.copy(position);
        this.splatMesh.quaternion.copy(quaternion);
        this.splatMesh.frustumCulled = false;
        this.splatMesh.renderOrder = 10;
        this.updateSplatMeshUniforms();

        this.splatRenderCount = splatCount;
    }

    setupSortWorker(splatBuffer) {
        return new Promise((resolve) => {
            const splatCount = splatBuffer.getSplatCount();
            this.sortWorker = createSortWorker(splatCount, SplatBuffer.RowSizeBytes);
            this.sortWorker.onmessage = (e) => {
                if (e.data.sortDone) {
                    this.sortRunning = false;
                    this.splatMesh.updateIndexes(this.outIndexArray, e.data.splatRenderCount);
                    this.lastSortTime = e.data.sortTime;
                } else if (e.data.sortCanceled) {
                    this.sortRunning = false;
                } else if (e.data.sortSetupPhase1Complete) {
                    console.log('Sorting web worker WASM setup complete.');
                    this.sortWorker.postMessage({
                        'positions': this.splatMesh.getCenters().buffer
                    });
                    this.outIndexArray = new Uint32Array(e.data.outIndexBuffer, e.data.outIndexOffset, splatBuffer.getSplatCount());
                    this.inIndexArray = new Uint32Array(e.data.inIndexBuffer, e.data.inIndexOffset, splatBuffer.getSplatCount());
                    for (let i = 0; i < splatCount; i++) this.inIndexArray[i] = i;
                } else if (e.data.sortSetupComplete) {
                    console.log('Sorting web worker ready.');
                    this.splatMesh.updateIndexes(this.outIndexArray, splatBuffer.getSplatCount());
                    const splatDataTextures = this.splatMesh.getSplatDataTextures();
                    const covariancesTextureSize = splatDataTextures.covariances.size;
                    const centersColorsTextureSize = splatDataTextures.centerColors.size;
                    console.log('Covariances texture size: ' + covariancesTextureSize.x + ' x ' + covariancesTextureSize.y);
                    console.log('Centers/colors texture size: ' + centersColorsTextureSize.x + ' x ' + centersColorsTextureSize.y);
                    this.updateView(true, true);
                    this.splatRenderingInitialized = true;
                    resolve();
                }
            };
        });
    }

    gatherSceneNodes = function() {

        const nodeRenderList = [];
        const tempVectorYZ = new THREE.Vector3();
        const tempVectorXZ = new THREE.Vector3();
        const tempVector = new THREE.Vector3();
        const tempMatrix4 = new THREE.Matrix4();
        const renderDimensions = new THREE.Vector3();
        const forward = new THREE.Vector3(0, 0, -1);

        const tempMax = new THREE.Vector3();
        const nodeSize = (node) => {
            return tempMax.copy(node.max).sub(node.min).length();
        };

        const MaximumDistanceToSort = 125;

        return function(gatherAllNodes) {

            this.getRenderDimensions(renderDimensions);
            const fovXOver2 = Math.atan(renderDimensions.x / 2.0 / this.cameraFocalLength);
            const fovYOver2 = Math.atan(renderDimensions.y / 2.0 / this.cameraFocalLength);
            const cosFovXOver2 = Math.cos(fovXOver2);
            const cosFovYOver2 = Math.cos(fovYOver2);
            tempMatrix4.copy(this.camera.matrixWorld).invert();
            tempMatrix4.multiply(this.splatMesh.matrixWorld);

            const splatTree = this.splatMesh.getSplatTree();
            let nodeRenderCount = 0;
            let splatRenderCount = 0;
            const nodeCount = splatTree.nodesWithIndexes.length;
            for (let i = 0; i < nodeCount; i++) {
                const node = splatTree.nodesWithIndexes[i];
                tempVector.copy(node.center).applyMatrix4(tempMatrix4);
                const distanceToNode = tempVector.length();
                tempVector.normalize();

                tempVectorYZ.copy(tempVector).setX(0).normalize();
                tempVectorXZ.copy(tempVector).setY(0).normalize();

                const cameraAngleXZDot = forward.dot(tempVectorXZ);
                const cameraAngleYZDot = forward.dot(tempVectorYZ);

                const ns = nodeSize(node);
                const outOfFovY = cameraAngleYZDot < (cosFovYOver2 - .4);
                const outOfFovX = cameraAngleXZDot < (cosFovXOver2 - .4);
                if (!gatherAllNodes && ((outOfFovX || outOfFovY) && distanceToNode > ns)) {
                    continue;
                }
                splatRenderCount += node.data.indexes.length;
                nodeRenderList[nodeRenderCount] = node;
                node.data.distanceToNode = distanceToNode;
                nodeRenderCount++;
            }

            nodeRenderList.length = nodeRenderCount;
            nodeRenderList.sort((a, b) => {
                if (a.data.distanceToNode > b.data.distanceToNode) return 1;
                else return -1;
            });

            this.splatRenderCount = splatRenderCount;
            this.splatSortCount = 0;
            let currentByteOffset = 0;
            for (let i = 0; i < nodeRenderCount; i++) {
                const node = nodeRenderList[i];
                const shouldSort = node.data.distanceToNode <= MaximumDistanceToSort;
                if (shouldSort) {
                    this.splatSortCount += node.data.indexes.length;
                }
                const windowSizeInts = node.data.indexes.length;
                let destView = new Uint32Array(this.inIndexArray.buffer, currentByteOffset, windowSizeInts);
                destView.set(node.data.indexes);
                currentByteOffset += windowSizeInts * Constants.BytesPerInt;
            }

        };

    }();

    start() {
        if (this.selfDrivenMode) {
            requestAnimationFrame(this.selfDrivenUpdateFunc);
            this.selfDrivenModeRunning = true;
        } else {
            throw new Error('Cannot start viewer unless it is in self driven mode.');
        }
    }

    updateFPS = function() {

        let lastCalcTime = performance.now() / 1000;
        let frameCount = 0;

        return function() {
            const currentTime = performance.now() / 1000;
            const calcDelta = currentTime - lastCalcTime;
            if (calcDelta >= 1.0) {
                this.currentFPS = frameCount;
                frameCount = 0;
                lastCalcTime = currentTime;
            } else {
                frameCount++;
            }
        };

    }();

    updateForRendererSizeChanges = function() {

        const lastRendererSize = new THREE.Vector2();
        const currentRendererSize = new THREE.Vector2();

        return function() {
            this.renderer.getSize(currentRendererSize);
            if (currentRendererSize.x !== lastRendererSize.x || currentRendererSize.y !== lastRendererSize.y) {
                if (!this.usingExternalCamera) {
                    this.camera.aspect = currentRendererSize.x / currentRendererSize.y;
                    this.camera.updateProjectionMatrix();
                }
                if (this.splatRenderingInitialized) {
                    this.updateSplatMeshUniforms();
                    this.updateSplatRenderTargetForRenderDimensions(currentRendererSize.x, currentRendererSize.y);
                }
                lastRendererSize.copy(currentRendererSize);
            }
        };

    }();

    selfDrivenUpdate() {
        if (this.selfDrivenMode) {
            requestAnimationFrame(this.selfDrivenUpdateFunc);
        }
        this.update();
        this.render();
    }

    update() {
        if (this.controls) {
            this.controls.update();
        }
        this.updateView();
        this.updateForRendererSizeChanges();

        this.rayCastScene();
        this.updateFPS();
        this.updateInfo();
    }

    rayCastScene = function() {

        const outHits = [];
        const renderDimensions = new THREE.Vector2();

        return function() {
            if (this.showMeshCursor) {
                this.getRenderDimensions(renderDimensions);
                outHits.length = 0;
                this.raycaster.setFromCameraAndScreenPosition(this.camera, this.mousePosition, renderDimensions);
                this.raycaster.intersectSplatMesh(this.splatMesh, outHits);
                if (outHits.length > 0) {
                    this.sceneHelper.setMeshCursorVisibility(true);
                    this.sceneHelper.positionAndOrientMeshCursor(outHits[0].origin, this.camera);
                } else {
                    this.sceneHelper.setMeshCursorVisibility(false);
                }
            } else {
                this.sceneHelper.setMeshCursorVisibility(false);
            }
        };

    }();

    updateInfo = function() {

        const renderDimensions = new THREE.Vector2();

        return function() {
            if (this.showInfo) {
                const splatCount = this.splatMesh.getSplatCount();
                this.getRenderDimensions(renderDimensions);

                const cameraPos = this.camera.position;
                const cameraPosString = `[${cameraPos.x.toFixed(5)}, ${cameraPos.y.toFixed(5)}, ${cameraPos.z.toFixed(5)}]`;
                this.infoPanelCells.cameraPosition.innerHTML = cameraPosString;

                const cameraLookAt = this.controls.target;
                const cameraLookAtString = `[${cameraLookAt.x.toFixed(5)}, ${cameraLookAt.y.toFixed(5)}, ${cameraLookAt.z.toFixed(5)}]`;
                this.infoPanelCells.cameraLookAt.innerHTML = cameraLookAtString;

                if (this.showMeshCursor) {
                    const cursorPos = this.sceneHelper.meshCursor.position;
                    const cursorPosString = `[${cursorPos.x.toFixed(5)}, ${cursorPos.y.toFixed(5)}, ${cursorPos.z.toFixed(5)}]`;
                    this.infoPanelCells.cursorPosition.innerHTML = cursorPosString;
                } else {
                    this.infoPanelCells.cursorPosition.innerHTML = 'N/A';
                }

                this.infoPanelCells.fps.innerHTML = this.currentFPS;
                this.infoPanelCells.renderWindow.innerHTML = `${renderDimensions.x} x ${renderDimensions.y}`;

                const renderPct = this.splatRenderCount / splatCount * 100;
                this.infoPanelCells.renderSplatCount.innerHTML =
                    `${this.splatRenderCount} splats out of ${splatCount} (${renderPct.toFixed(2)}%)`;

                this.infoPanelCells.sortTime.innerHTML = `${this.lastSortTime.toFixed(3)} ms`;
            }
        };

    }();

    render() {
        this.renderer.autoClear = false;
        this.renderer.setClearColor(0.0, 0.0, 0.0, 0.0);

        const sceneHasRenderables = (scene) => {
            for (let child of scene.children) {
                if (child.visible) {
                   return true;
                }
            }
            return false;
        };

        let defualtSceneHasRenderables = sceneHasRenderables(this.scene);
        let simpleSceneHasRenderables = sceneHasRenderables(this.simpleScene);

        // A more complex rendering sequence is required if you want to render "normal" Three.js
        // objects along with the splats
        if (defualtSceneHasRenderables || simpleSceneHasRenderables) {
            this.renderer.setRenderTarget(this.splatRenderTarget);
            this.renderer.clear(true, true, true);
            this.renderer.getContext().colorMask(false, false, false, false);
            if (defualtSceneHasRenderables) this.renderer.render(this.scene, this.camera);
            if (simpleSceneHasRenderables) {
                const simpleSceneOverrideMaterial = this.simpleScene.overrideMaterial;
                this.simpleScene.overrideMaterial = this.simpleObjectDepthOverrideMaterial;
                this.renderer.render(this.simpleScene, this.camera);
                this.simpleScene.overrideMaterial = simpleSceneOverrideMaterial;
            }
            this.renderer.getContext().colorMask(true, true, true, true);
            this.renderer.render(this.splatMesh, this.camera);

            this.renderer.setRenderTarget(null);
            this.renderer.clear(true, true, true);

            if (defualtSceneHasRenderables) this.renderer.render(this.scene, this.camera);
            if (simpleSceneHasRenderables) this.renderer.render(this.simpleScene, this.camera);
            this.renderTargetCopyMaterial.uniforms.sourceColorTexture.value = this.splatRenderTarget.texture;
            this.renderTargetCopyMaterial.uniforms.sourceDepthTexture.value = this.splatRenderTarget.depthTexture;
            this.renderer.render(this.renderTargetCopyQuad, this.renderTargetCopyCamera);
        } else {
            this.renderer.clear(true, true, true);
            this.renderer.render(this.splatMesh, this.camera);
        }
    }

    updateView = function() {

        const tempMatrix = new THREE.Matrix4();
        const cameraPositionArray = [];
        const lastSortViewDir = new THREE.Vector3(0, 0, -1);
        const sortViewDir = new THREE.Vector3(0, 0, -1);
        const lastSortViewPos = new THREE.Vector3();
        const sortViewOffset = new THREE.Vector3();

        return function(force = false, gatherAllNodes = false) {
            if (!force) {
                sortViewDir.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
                let needsRefreshForRotation = false;
                let needsRefreshForPosition = false;
                if (sortViewDir.dot(lastSortViewDir) <= 0.95) needsRefreshForRotation = true;
                if (sortViewOffset.copy(this.camera.position).sub(lastSortViewPos).length() >= 1.0) needsRefreshForPosition = true;
                if (!needsRefreshForRotation && !needsRefreshForPosition) return;
            }

            tempMatrix.copy(this.camera.matrixWorld).invert();
            tempMatrix.premultiply(this.camera.projectionMatrix);
            tempMatrix.multiply(this.splatMesh.matrixWorld);
            cameraPositionArray[0] = this.camera.position.x;
            cameraPositionArray[1] = this.camera.position.y;
            cameraPositionArray[2] = this.camera.position.z;

            if (!this.sortRunning) {
                this.gatherSceneNodes(gatherAllNodes);
                this.sortRunning = true;
                this.sortWorker.postMessage({
                    sort: {
                        'view': tempMatrix.elements,
                        'cameraPosition': cameraPositionArray,
                        'splatRenderCount': this.splatRenderCount,
                        'splatSortCount': this.splatSortCount,
                        'inIndexBuffer': this.inIndexArray.buffer
                    }
                });
                lastSortViewPos.copy(this.camera.position);
                lastSortViewDir.copy(sortViewDir);
            }
        };

    }();

    getSplatMesh() {
        return this.splatMesh;
    }
}
