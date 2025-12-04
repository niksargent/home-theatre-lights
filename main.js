/***************************************
     * Global App State and DOM References *
 ***************************************/
    const AppState = {
      bridgeIP: "",
      username: "",
      discoveredLights: {},
      groups: [
        { id: "group-unassigned", name: "Unassigned Lights", lights: [], scenes: [],
          lastBrightness: 254, lastColor: "#FFFFFF", speed: 120,
          collapsed: false,
          chaseMode: "off",
          flashMode: "off",
          toggleFlash: false,
          strobeEnabled: false,
          bpmLocked: true,
          effectsExpanded: false
        }
      ],
      groupCounter: 1,
      groupLayout: "horizontal",
      controlsPosition: "top",
      darkMode: "normal",
      globalBPM: 120,
      useMock: false,
      dom: {
        flyoutPanel: document.getElementById('flyout-panel'),
        bridgeInput: document.getElementById('bridge-ip'),
        authStatus: document.getElementById('auth-status'),
        discoverStatus: document.getElementById('discover-status'),
        groupsContainer: document.getElementById('groups-container'),
        lightFilter: document.getElementById('light-filter'),
        flashDelay: document.getElementById('flash-delay'),
        autoRefreshUnassigned: document.getElementById('auto-refresh-unassigned'),
        controlsPosition: document.getElementById('controls-position'),
        darkMode: document.getElementById('dark-mode'),
        useMock: document.getElementById('use-mock')
      }
    };

    /******************************
     * Utility Functions (Utils)  *
     ******************************/
    const Utils = {
      isUniqueGroupName: function(name, excludeGroupId) {
        return !AppState.groups.some(g => g.name === name && g.id !== excludeGroupId);
      },
      getUniqueName: function(name, excludeGroupId) {
        let uniqueName = name;
        let counter = 2;
        while (!this.isUniqueGroupName(uniqueName, excludeGroupId)) {
          uniqueName = name + " (" + counter + ")";
          counter++;
        }
        return uniqueName;
      },
      darkenColor: function(hex, factor) {
        factor = Math.max(factor, 0.3);
        let r = parseInt(hex.substr(1, 2), 16);
        let g = parseInt(hex.substr(3, 2), 16);
        let b = parseInt(hex.substr(5, 2), 16);
        r = Math.round(r * factor);
        g = Math.round(g * factor);
        b = Math.round(b * factor);
        return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();
      },
      hexToHSL: function(H) {
        let r = 0, g = 0, b = 0;
        if (H.length === 4) {
          r = "0x" + H[1] + H[1];
          g = "0x" + H[2] + H[2];
          b = "0x" + H[3] + H[3];
        } else if (H.length === 7) {
          r = "0x" + H[1] + H[2];
          g = "0x" + H[3] + H[4];
          b = "0x" + H[5] + H[6];
        }
        r /= 255; g /= 255; b /= 255;
        const cmin = Math.min(r, g, b);
        const cmax = Math.max(r, g, b);
        const delta = cmax - cmin;
        let h = 0, s = 0, l = (cmax + cmin) / 2;
        if (delta !== 0) {
          if (cmax === r) h = ((g - b) / delta) % 6;
          else if (cmax === g) h = (b - r) / delta + 2;
          else h = (r - g) / delta + 4;
        }
        h = Math.round(h * 60);
        if (h < 0) h += 360;
        s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
        s = +(s * 100).toFixed(1);
        l = +l.toFixed(1) * 100;
        return { h, s, l };
      },
      attachSliderHandlers: function(slider, parentElement) {
        slider.draggable = false;
        slider.addEventListener('pointerdown', e => {
          e.stopPropagation();
          parentElement.sliderActive = true;
        });
        slider.addEventListener('pointerup', e => {
          e.stopPropagation();
          parentElement.sliderActive = false;
        });
        slider.addEventListener('touchstart', e => {
          e.stopPropagation();
          parentElement.sliderActive = true;
        });
        slider.addEventListener('touchend', e => {
          e.stopPropagation();
          parentElement.sliderActive = false;
        });
        slider.addEventListener('dragstart', e => e.stopPropagation());
        slider.addEventListener('mousedown', e => e.stopPropagation());
      }
    };

    /*******************************
     * This function added by nik in 4.7 to combine a hue light update with a local state update also
     * it probably belongs somewhere else in this file *
     *******************************/
    async function updateLightAndLocalState(lightId, newState) {
        await HueAPI.updateLightState(lightId, newState);
        if (AppState.discoveredLights[lightId]) {
            AppState.discoveredLights[lightId].state = {
            ...AppState.discoveredLights[lightId].state,
            ...newState
            };
        }
    }

// added 5.0 by nik as helper functions to reduce code duplication
    function getActiveLights(group) {
      return group.lights.filter(lightId => {
        const light = AppState.discoveredLights[lightId];
        return light && light.selected;
      });
    }

    async function updateGroupActiveLights(group, updateObj) {
      const activeLights = getActiveLights(group);
      await Promise.all(activeLights.map(async (lightId) => {
        await updateLightAndLocalState(lightId, updateObj);
      }));
    }
// end of addition in 5.0


    /* added by nik in 4.8 to help with converting bpm to transition time */

    function calculateTransitionTime(bpm) {
  // Returns transition time in deciseconds based on the BPM value.
  // Mapping:
  // 0 BPM -> 0 sec, 30 BPM -> ~1 sec, 120 BPM -> ~5 sec, 300 BPM -> ~60 sec.
  if (bpm <= 0) return 0; // instantaneous if zero or negative.
  const seconds = 0.1835 * Math.pow(bpm, 0.3954) * Math.exp(0.01180 * bpm);
  return Math.round(seconds * 10);  // convert seconds to deciseconds.
    }


  /* --------------------------------------------------
   FlashController Module (v5.0)
   - Centralizes the cancellation of pending flash timers.
   - When a flash+transition scene is triggered,
     a timer is started and its handle is stored in the group object as group.pendingFlashTimeout.
   - If a new realtime event occurs, call cancelPendingFlash(group)
     to cancel the timer so that its callback will not run.
-------------------------------------------------- */
const FlashController = {
  cancelPendingFlash: function(group) {
    if (group.pendingFlashTimeout) {
      clearTimeout(group.pendingFlashTimeout);
      group.pendingFlashTimeout = null;
      console.log(`Flash timer for group ${group.id} cancelled.`);
    }
  }
};
  

    /***********************
     * HueAPI Module       *
     ***********************/
    // HueAPI and MockHueAPI are provided by transport.js

    /*******************************
     * GroupManager Module         *
     *******************************/
    const GroupManager = {
      createGroup: function() {
        const groupId = `group-${AppState.groupCounter++}`;
        const groupName = Utils.getUniqueName("Group", null);
        AppState.groups.push({
          id: groupId,
          name: groupName,
          lights: [],
          scenes: [],
          lastBrightness: 254,
          lastColor: "#FFFFFF",
          speed: AppState.globalBPM,
          collapsed: false,
          chaseMode: "off",
          flashMode: "off",
          toggleFlash: false,
          strobeEnabled: false,
          bpmLocked: true,
          effectsExpanded: false
        });
          // UIRenderer.renderGroups();
          scheduleRender();  // 5.1 added to debounce the render
      },
      deleteGroup: function(groupId) {
        if (groupId === "group-unassigned") return;
        AppState.groups = AppState.groups.filter(g => g.id !== groupId);
          // UIRenderer.renderGroups();
          scheduleRender();  // 5.1 added to debounce the render
      },
      reconcileGroupLights: function() {
        AppState.groups.forEach(group => {
          group.lights = group.lights.filter(lightId => AppState.discoveredLights.hasOwnProperty(lightId));
        });
        const assigned = new Set();
        AppState.groups.forEach(group => group.lights.forEach(lightId => assigned.add(lightId)));
        const unassigned = AppState.groups.find(g => g.id === "group-unassigned");
        if (unassigned) {
          for (const lightId in AppState.discoveredLights) {
            if (!assigned.has(lightId)) unassigned.lights.push(lightId);
          }
        }
 
        // 4.9 - set any unset lights for the first time 
        Object.keys(AppState.discoveredLights).forEach(lightId => {
        // If 'selected' is undefined, default to true
            if (typeof AppState.discoveredLights[lightId].selected === "undefined") {
                AppState.discoveredLights[lightId].selected = true;
            }
        });     // end of 4.9 addition  


      },
      removeLightFromAllGroups: function(lightId) {
        AppState.groups.forEach(group => {
          const idx = group.lights.indexOf(lightId);
          if (idx !== -1) group.lights.splice(idx, 1);
        });
      },
      toggleGroupLayout: function() {
        AppState.groupLayout = (AppState.groupLayout === "horizontal") ? "vertical" : "horizontal";
          // UIRenderer.renderGroups();
          scheduleRender();  // 5.1 added to debounce the render
      },
      reorderGroups: function(draggedGroupId, targetGroupId) {
        const draggedIndex = AppState.groups.findIndex(g => g.id === draggedGroupId);
        const targetIndex = AppState.groups.findIndex(g => g.id === targetGroupId);
        if (draggedIndex < 0 || targetIndex < 0 || draggedIndex === targetIndex) return;
        const [draggedGroup] = AppState.groups.splice(draggedIndex, 1);
        AppState.groups.splice(targetIndex, 0, draggedGroup);
      },
      groupDrop: function(e, groupId) {
        e.preventDefault();
        e.stopPropagation();
        const data = e.dataTransfer.getData("text/plain");
        if (data.startsWith("light:")) {
          const lightId = data.split(":")[1];
          this.removeLightFromAllGroups(lightId);
          const targetGroup = AppState.groups.find(g => g.id === groupId);
          if (targetGroup && !targetGroup.lights.includes(lightId)) {
            targetGroup.lights.push(lightId);
          }
          // UIRenderer.renderGroups();
          scheduleRender();  // 5.1 added to debounce the render
        }
      },
      relockBPM: function(groupId) {
        const group = AppState.groups.find(g => g.id === groupId);
        if (!group) return;
        group.speed = AppState.globalBPM;
        group.bpmLocked = true;
          // UIRenderer.renderGroups();
          scheduleRender();  // 5.1 added to debounce the render
      },
      toggleEffectsPanel: function(groupId) {
        const group = AppState.groups.find(g => g.id === groupId);
        if (!group) return;
        group.effectsExpanded = !group.effectsExpanded;
          // UIRenderer.renderGroups();
          scheduleRender();  // 5.1 added to debounce the render
      },
      setChaseMode: function(groupId, mode) {
        const group = AppState.groups.find(g => g.id === groupId);
        if (!group) return;
        group.chaseMode = mode;
        Effects.updateChaseState(groupId);
          // UIRenderer.renderGroups();
          scheduleRender();  // 5.1 added to debounce the render
      },
      setFlashMode: function(groupId, mode) {
        const group = AppState.groups.find(g => g.id === groupId);
        if (!group) return;
        group.flashMode = mode;
          // UIRenderer.renderGroups();
          scheduleRender();  // 5.1 added to debounce the render
      },
      setToggleFlash: function(groupId, enabled) {
        const group = AppState.groups.find(g => g.id === groupId);
        if (!group) return;
        group.toggleFlash = enabled;
          // UIRenderer.renderGroups();
          scheduleRender();  // 5.1 added to debounce the render
      },
      setBPMSync: function(groupId, enabled) {
        const group = AppState.groups.find(g => g.id === groupId);
        if (!group) return;
        group.bpmLocked = enabled;
        if (enabled) group.speed = AppState.globalBPM;
          // UIRenderer.renderGroups();
          scheduleRender();  // 5.1 added to debounce the render
      },
      setStrobeEnabled: function(groupId, enabled) {
        const group = AppState.groups.find(g => g.id === groupId);
        if (!group) return;
        group.strobeEnabled = enabled;
          // UIRenderer.renderGroups();
          scheduleRender();  // 5.1 added to debounce the render
      },
      groupSetColor: async function(groupId, colorValue) {
        // colorValue will be in RGB format (e.g., "rgb(255, 0, 0)")
        // Convert RGB to a hex string for storage/display.
        function rgbToHex(rgb) {
          const result = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(rgb);
          return result
            ? "#" + ("0" + parseInt(result[1], 10).toString(16)).slice(-2) +
                  ("0" + parseInt(result[2], 10).toString(16)).slice(-2) +
                  ("0" + parseInt(result[3], 10).toString(16)).slice(-2)
            : rgb;
        }
        const hexColor = rgbToHex(colorValue);
        const hsl = Utils.hexToHSL(hexColor);
        const hueValue = Math.round((hsl.h / 360) * 65535);
        const satValue = Math.round((hsl.s / 100) * 254);
        const group = AppState.groups.find(g => g.id === groupId);
        if (!group) return;
        FlashController.cancelPendingFlash(group);  // 5.0 Request Cancel any pending hub-based flash transition
        // taken out in 4.8 to allow for bpm speed conversion 
        // const transitiontime = typeof group.speed === "number" ? group.speed : 10;
        const transitiontime = calculateTransitionTime(group.speed); // new in 4.8
        /* new helper function in 5.0 */
        const updateObj = { on: true, hue: hueValue, sat: satValue, transitiontime, alert: "none" };
          await updateGroupActiveLights(group, updateObj);
        group.lastColor = hexColor;
          // UIRenderer.renderGroups();
          scheduleRender();  // 5.1 added to debounce the render
      },
      groupSetBrightness: async function(groupId, brightness) {
        const newBri = parseInt(brightness);
        //const transitiontime = 10;
        // taken out in 4.8 to allow for bpm speed conversion 
         const group = AppState.groups.find(g => g.id === groupId);
        if (!group) return;
        FlashController.cancelPendingFlash(group);  // 5.0 Request Cancel any pending hub-based flash transition
         const transitiontime = calculateTransitionTime(group.speed); // new in 4.8 - note position AFTER group is defined
        /* new helper function in 5.0 */
        const updateObj = { bri: newBri, transitiontime, alert: "none" };
        await updateGroupActiveLights(group, updateObj);
        /* end of 5.0 addition */
        group.lastBrightness = newBri;
          // UIRenderer.renderGroups();
          scheduleRender();  // 5.1 added to debounce the render
      },
      // this takes a parameter for transition time in deciseconds - generalised for all groupOff functions
      groupOff: async function(groupId, transitionTime=0) {
        // note the LLM has used/created targetGroup here, not "group" as above!
        const targetGroup = AppState.groups.find(g => g.id === groupId);
        if (!targetGroup) return;
        FlashController.cancelPendingFlash(targetGroup);  // 5.0 Request Cancel any pending hub-based flash transition
        /* new helper function in 5.0 */
        if (transitionTime === -1) { 
            transitionTime = calculateTransitionTime(targetGroup.speed); 
        }
       const updateObj = { on: false, transitiontime: transitionTime, alert: "none" };
        await updateGroupActiveLights(targetGroup, updateObj);
        /* end of 5.0 addition */
          // UIRenderer.renderGroups();
          scheduleRender();  // 5.1 added to debounce the render
      },
      groupBlackout: async function(groupId) {await this.groupOff(groupId, 0); },
      groupOff1: async function(groupId) {await this.groupOff(groupId, 10); },
      groupOff5: async function(groupId) {await this.groupOff(groupId, 50); },
      groupOffT: async function(groupId) {await this.groupOff(groupId, -1); },

      // this takes a parameter for transition time in deciseconds
      groupOn: async function(groupId, transitionTime=0) {
        const targetGroup = AppState.groups.find(g => g.id === groupId);
        if (!targetGroup) return;
        FlashController.cancelPendingFlash(targetGroup);  // 5.0 Request Cancel any pending hub-based flash transition
        // added 5.1 to support instant on, or fade-on of any length
        if (transitionTime === -1) { 
            transitionTime = calculateTransitionTime(targetGroup.speed); 
        }
       /* new helper function in 5.0 */
       const updateObj = { on: true, transitiontime: transitionTime, alert: "none" };
        await updateGroupActiveLights(targetGroup, updateObj);
        /* end of 5.0 addition */
          // UIRenderer.renderGroups();
          scheduleRender();  // 5.1 added to debounce the render
      },
      groupOn1: async function(groupId) { await this.groupOn(groupId, 10); },
      groupOn5: async function(groupId) { await this.groupOn(groupId, 50); },
      groupOnT: async function(groupId) { await this.groupOn(groupId, -1); }, /* added 5.0 nik to differentiate between instant on to mirror blackout, and fade-on of any length */
      groupSetWarmWhite: async function(groupId) {
        const group = AppState.groups.find(g => g.id === groupId);
        if (!group) return;
        FlashController.cancelPendingFlash(group);  // 5.0 Request Cancel any pending hub-based flash transition
        const transitiontime = calculateTransitionTime(group.speed); 
        /* new helper function in 5.0 */ 
        const updateObj = { on: true, ct: 500, transitiontime, alert: "none" };
        await updateGroupActiveLights(group, updateObj);
        /* end of 5.0 addition */
        // set group.lastColor to approximate warm white - updates colour picker panel
        group.lastColor = "#FFF4E5";
          // UIRenderer.renderGroups();
          scheduleRender();  // 5.1 added to debounce the render
        },
      groupSetCoolWhite: async function(groupId) {
        const group = AppState.groups.find(g => g.id === groupId);
        if (!group) return;
        FlashController.cancelPendingFlash(group);  // 5.0 Request Cancel any pending hub-based flash transition
        const transitiontime = calculateTransitionTime(group.speed); /* added 5.0 - was missing! */
        /* new helper function in 5.0 */ 
        const updateObj = { on: true, ct: 153, transitiontime, alert: "none" };
        await updateGroupActiveLights(group, updateObj);
        /* end of 5.0 addition */
        group.lastColor = "#E5F4FF";
          // UIRenderer.renderGroups();
          scheduleRender();  // 5.1 added to debounce the render
      },
      groupSetSpeed: function(groupId, newSpeed) {
        const group = AppState.groups.find(g => g.id === groupId);
        if (!group) return;
        group.speed = parseInt(newSpeed);
        group.bpmLocked = false;
        if (group.chaseMode !== "off") {
          Effects.stopChase(groupId);
          Effects.startChase(groupId);
        }
          // UIRenderer.renderGroups();
          scheduleRender();  // 5.1 added to debounce the render
      },
      // added 4.9 for select all function 
      selectAll: function(groupId) {
        const group = AppState.groups.find(g => g.id === groupId);
        if (!group) return;
        group.lights.forEach(lightId => {
            if (AppState.discoveredLights[lightId]) {
            AppState.discoveredLights[lightId].selected = true;
            }
        });
          // UIRenderer.renderGroups();
          scheduleRender();  // 5.1 added to debounce the render
        },
        deselectAll: function(groupId) {
        const group = AppState.groups.find(g => g.id === groupId);
        if (!group) return;
        group.lights.forEach(lightId => {
            if (AppState.discoveredLights[lightId]) {
            AppState.discoveredLights[lightId].selected = false;
            }
        });
          // UIRenderer.renderGroups();
          scheduleRender();  // 5.1 added to debounce the render
        }, // end of 4.9 addition

      saveGroupsToStorage: function() {
        localStorage.setItem('hueGroups', JSON.stringify(AppState.groups));
        localStorage.setItem('controlsPosition', AppState.controlsPosition);
        localStorage.setItem('darkMode', AppState.darkMode);
        localStorage.setItem('globalBPM', AppState.globalBPM);
      },
      loadGroupsFromStorage: function() {
        const stored = localStorage.getItem('hueGroups');
        if (stored) {
          try {
            const loadedGroups = JSON.parse(stored);
            if (Array.isArray(loadedGroups)) {
              AppState.groups = loadedGroups;
            }
          } catch (e) {
            console.error("Error parsing stored groups:", e);
          }
        }
        let maxCounter = 0;
        AppState.groups.forEach(group => {
          if (group.id.startsWith("group-") && group.id !== "group-unassigned") {
            const num = parseInt(group.id.replace("group-", ""));
            if (!isNaN(num) && num > maxCounter) {
              maxCounter = num;
            }
          }
          group.chaseMode = group.chaseMode || "off";
          group.flashMode = group.flashMode || "off";
          group.toggleFlash = group.toggleFlash || false;
          group.strobeEnabled = group.strobeEnabled || false;
          if (typeof group.bpmLocked === "undefined") group.bpmLocked = true;
          if (typeof group.effectsExpanded === "undefined") group.effectsExpanded = false;
        });
        AppState.groupCounter = maxCounter + 1;
        const storedCP = localStorage.getItem('controlsPosition');
        if (storedCP) { 
          AppState.controlsPosition = storedCP; 
          AppState.dom.controlsPosition.value = storedCP; 
        }
        const storedDM = localStorage.getItem('darkMode');
        if (storedDM) { 
          AppState.darkMode = storedDM; 
          AppState.dom.darkMode.value = storedDM; 
          UIRenderer.updateDarkMode(storedDM);
        }
        const storedFlashDelay = localStorage.getItem('flashDelay');
        if (storedFlashDelay) {
          AppState.dom.flashDelay.value = storedFlashDelay;
        }
        const storedGlobalBPM = localStorage.getItem('globalBPM');
        if (storedGlobalBPM) {
          AppState.globalBPM = parseInt(storedGlobalBPM);
        }
        const storedUseMock = localStorage.getItem('useMock');
        if (storedUseMock) {
          AppState.useMock = storedUseMock === "true";
          if (AppState.dom.useMock) {
            AppState.dom.useMock.checked = AppState.useMock;
          }
        }
      }
    };

    /*******************************
     * GlobalSettings Module       *
     *******************************/
    const GlobalSettings = {
      setGlobalBPM: function(value) {
        const bpm = parseInt(value);
        if (isNaN(bpm) || bpm < 0) return;
        AppState.globalBPM = bpm;
        localStorage.setItem('globalBPM', bpm);
        AppState.groups.forEach(group => {
          if (group.bpmLocked) {
            group.speed = bpm;
          }
        });
          // UIRenderer.renderGroups();
          scheduleRender();  // 5.1 added to debounce the render
      }
    };

    /*******************************
     * UIRenderer De-bouncer           *
     *******************************/
     let renderTimeout = null;
    function scheduleRender(delay = 50) {
    if (renderTimeout) clearTimeout(renderTimeout);
    renderTimeout = setTimeout(() => {
        UIRenderer.renderGroups();
        renderTimeout = null;
    }, delay);
    }


    /*******************************
     * UIRenderer Module           *
     *******************************/
    const UIRenderer = {
      renderGroups: function() {
        AppState.dom.groupsContainer.classList.remove("horizontal", "vertical");
        AppState.dom.groupsContainer.classList.add(AppState.groupLayout);
        AppState.dom.groupsContainer.innerHTML = "";
        AppState.groups.forEach(group => {
          const groupDiv = document.createElement('div');
          groupDiv.className = "group" + (group.id === "group-unassigned" ? " unassigned" : "");
          groupDiv.id = group.id;
          
          // Group Header
          const header = document.createElement('div');
          header.className = "group-header";
          header.draggable = true;
          const titleEl = document.createElement('h3');
          titleEl.innerText = group.name;
          titleEl.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            this.makeGroupTitleEditable(titleEl, group);
          });
          header.appendChild(titleEl);
          const collapseBtn = document.createElement('button');
          collapseBtn.className = "collapse-toggle";
          collapseBtn.innerText = group.collapsed ? '+' : '–';
          collapseBtn.onclick = e => {
            e.stopPropagation();
            group.collapsed = !group.collapsed;
            this.renderGroups();
          };
          header.appendChild(collapseBtn);
          if (group.id !== "group-unassigned") {
            const delBtn = document.createElement('button');
            delBtn.className = "delete-group";
            delBtn.innerText = "X";
            delBtn.onclick = () => GroupManager.deleteGroup(group.id);
            header.appendChild(delBtn);
          }
          header.addEventListener('dragstart', e => {
            e.dataTransfer.setData("text/plain", `group:${group.id}`);
          });
          groupDiv.appendChild(header);
          
          if (!group.collapsed) {
            if (AppState.controlsPosition === "top") {
              groupDiv.appendChild(this.createRealtimeControlsElement(group));
              // Insert Effects Toggle Button in its own row:
                const effectsToggle = document.createElement('div');
                effectsToggle.className = "effects-toggle";
                effectsToggle.style.marginTop = "5px";
                effectsToggle.innerHTML = `<button type="button" onclick="GroupManager.toggleEffectsPanel('${group.id}')">Effects ▼</button>`;
                groupDiv.appendChild(effectsToggle);

              if (group.effectsExpanded) {
                groupDiv.appendChild(this.createEffectsPanel(group));
                
              }
              groupDiv.appendChild(Scenes.createSceneManagementElement(group));
            }
            groupDiv.appendChild(this.createDropzoneElement(group));
            if (AppState.controlsPosition === "bottom") {
              groupDiv.appendChild(this.createRealtimeControlsElement(group));
              // Insert Effects Toggle Button in its own row:
                const effectsToggle = document.createElement('div');
                effectsToggle.className = "effects-toggle";
                effectsToggle.style.marginTop = "5px";
                effectsToggle.innerHTML = `<button type="button" onclick="GroupManager.toggleEffectsPanel('${group.id}')">Effects ▼</button>`;
                groupDiv.appendChild(effectsToggle);

              if (group.effectsExpanded) {
                groupDiv.appendChild(this.createEffectsPanel(group));
              }
              groupDiv.appendChild(Scenes.createSceneManagementElement(group));
            }
          }
          
          groupDiv.addEventListener('dragover', e => e.preventDefault());
          groupDiv.addEventListener('drop', e => this.groupDropOnGroup(e));
          AppState.dom.groupsContainer.appendChild(groupDiv);
          
          // Initialize the rainbow gradient picker for this group.
          initializeRainbowPicker(group.id);
        });
        GroupManager.saveGroupsToStorage();
      },
      createRealtimeControlsElement: function(group) {
        const rtDiv = document.createElement('div');
        rtDiv.className = "realtime-controls";
        const currentColor = group.lastColor || "#FFFFFF";
        const currentBrightness = group.lastBrightness || 254;
        const bpmDisplay = group.speed === 0 ? "--" : group.speed;
        // Replace the old color picker with a canvas-based gradient slider and preview box.
        rtDiv.innerHTML = `
          <div style="display:flex; align-items:center;">
            <div id="selected-color-preview-${group.id}" style="width:30px; height:30px; margin-left:10px; border:1px solid #ccc; background-color:${group.lastColor ? group.lastColor : '#ccc'};"></div>
            <canvas id="rainbow-picker-${group.id}" width="150" height="30" style="cursor:pointer; border:1px solid #ccc; border-radius:5px;"></canvas>
          </div>
          <div>
            <label name="luxlabel">💡</label>
            <input type="range" min="1" max="254" value="${currentBrightness}" onchange="GroupManager.groupSetBrightness('${group.id}', this.value)">
          </div>
          <div class="speed-control">
            <label name="speedlabel">🏃‍➡️</label>
            <input type="range" min="0" max="300" value="${group.speed}" 
                    onchange="GroupManager.groupSetSpeed('${group.id}', this.value)" 
                    ondblclick="GroupManager.relockBPM('${group.id}')">
            <span class="bpm-display">${group.speed} BPM (${(calculateTransitionTime(group.speed) / 10).toFixed(1)}s)</span>
            </span>
          </div>

            <div class="preset-buttons">
                <button style="background-color: rgba(255,244,229,0.5);" onclick="GroupManager.groupSetWarmWhite('${group.id}')">WW</button>
                <button style="background-color: rgba(224,240,255,0.5);" onclick="GroupManager.groupSetCoolWhite('${group.id}')">CW</button>
                <button style="background-color: rgba(255,102,102,0.5);" onclick="GroupManager.groupSetColor('${group.id}', '#FF0000')">R</button>
                <button style="background-color: rgba(255,200,150,0.5);" onclick="GroupManager.groupSetColor('${group.id}', '#FFA500')">O</button>
                <button style="background-color: rgba(255,255,102,0.5);" onclick="GroupManager.groupSetColor('${group.id}', '#FFFF00')">Y</button>
                <button style="background-color: rgba(102,255,102,0.5);" onclick="GroupManager.groupSetColor('${group.id}', '#00FF00')">G</button>
                <button style="background-color: rgba(102,178,255,0.5);" onclick="GroupManager.groupSetColor('${group.id}', '#0000FF')">B</button>
                <button style="background-color: rgba(100,100,150,0.5);" onclick="GroupManager.groupSetColor('${group.id}', '#4B0082')">I</button>
                <button style="background-color: rgba(200,150,200,0.5);" onclick="GroupManager.groupSetColor('${group.id}', '#EE82EE')">V</button>
                <button style="background-color: rgba(255,102,255,0.5);" onclick="GroupManager.groupSetColor('${group.id}', '#FF00FF')">M</button>
            </div>
            <div class="preset-buttons">
                <button style="background-color: rgba(100,100,100,0.5);" onclick="GroupManager.groupBlackout('${group.id}')">Blackout</button>
                <button style="background-color: rgba(100,100,100,0.5);" onclick="GroupManager.groupOff1('${group.id}')">Off 1</button>
                <button style="background-color: rgba(100,100,100,0.5);" onclick="GroupManager.groupOff5('${group.id}')">Off 5</button>
                <button style="background-color: rgba(100,100,100,0.5);" onclick="GroupManager.groupOffT('${group.id}')">Off T</button>
                <button style="background-color: rgba(220,220,220,0.5);" onclick="GroupManager.groupOn('${group.id}', 0)">On</button>
                <button style="background-color: rgba(220,220,220,0.5);" onclick="GroupManager.groupOn1('${group.id}')">On 1</button>
                <button style="background-color: rgba(220,220,220,0.5);" onclick="GroupManager.groupOn5('${group.id}')">On 5</button>
                <button style="background-color: rgba(220,220,220,0.5);" onclick="GroupManager.groupOnT('${group.id}')">On T</button>
            </div>
            <div class="preset-buttons">
            <button onclick="GroupManager.selectAll('${group.id}')">Select All</button>
            <button onclick="GroupManager.deselectAll('${group.id}')">Deselect All</button>
            </div>

        `;
        return rtDiv;
      },
      createEffectsPanel: function(group) {
        const panel = document.createElement('div');
        panel.className = "effects-panel";
        panel.innerHTML = `
          <div>
            <label>Chase Mode:</label>
            <select onchange="GroupManager.setChaseMode('${group.id}', this.value)">
              <option value="off" ${group.chaseMode==="off"?"selected":""}>Off</option>
              <option value="rotate" ${group.chaseMode==="rotate"?"selected":""}>Rotate Pattern</option>
              <option value="left" ${group.chaseMode==="left"?"selected":""}>Left</option>
              <option value="right" ${group.chaseMode==="right"?"selected":""}>Right</option>
              <option value="classic" ${group.chaseMode==="classic"?"selected":""}>Classic</option>
              <option value="ripple" ${group.chaseMode==="ripple"?"selected":""}>Ripple</option>
              <option value="ping-pong" ${group.chaseMode==="ping-pong"?"selected":""}>Ping-Pong</option>
            </select>
          </div>
          <div>
            <button type="button" onclick="GroupManager.setChaseMode('${group.id}', 'off')">Stop Chase</button>
          </div>
          <div>
            <label>Flash Mode:</label>
            <select onchange="GroupManager.setFlashMode('${group.id}', this.value)">
              <option value="off" ${group.flashMode==="off"?"selected":""}>Off</option>
              <option value="staggered" ${group.flashMode==="staggered"?"selected":""}>Staggered</option>
              <option value="rolling" ${group.flashMode==="rolling"?"selected":""}>Rolling</option>
              <option value="random" ${group.flashMode==="random"?"selected":""}>Random</option>
              <option value="pulsing" ${group.flashMode==="pulsing"?"selected":""}>Pulsing</option>
            </select>
          </div>
          <div>
            <label><input type="checkbox" onchange="GroupManager.setToggleFlash('${group.id}', this.checked)" ${group.toggleFlash?"checked":""}> Toggle Flash</label>
          </div>
          <div>
            <label><input type="checkbox" onchange="GroupManager.setBPMSync('${group.id}', this.checked)" ${group.bpmLocked?"checked":""}> BPM Sync</label>
          </div>
          <div>
            <label><input type="checkbox" onchange="GroupManager.setStrobeEnabled('${group.id}', this.checked)" ${group.strobeEnabled?"checked":""}> Strobe</label>
          </div>
        `;
        return panel;
      },
      createSceneManagementElement: function(group) {
        const sceneDiv = document.createElement('div');
        sceneDiv.id = "scene-management-" + group.id;
        sceneDiv.style.borderTop = "1px solid #888";
        sceneDiv.style.marginTop = "10px";
        sceneDiv.style.paddingTop = "5px";
        const controlsDiv = document.createElement('div');
        controlsDiv.innerHTML = `
          <input type="text" id="scene-name-${group.id}" placeholder="Scene name" style="width:120px;">
          <input type="number" id="scene-transition-${group.id}" placeholder="Time" style="width:50px;" value="10">
          <label style="font-size:0.9em;"><input type="checkbox" id="scene-flash-${group.id}"> Flash</label>
          <button onclick="Scenes.saveSceneForGroup('${group.id}')">Save</button>
        `;
        sceneDiv.appendChild(controlsDiv);
        const scenesList = document.createElement('div');
        scenesList.id = "scenes-container-" + group.id;
        if (group.scenes && group.scenes.length > 0) {
          group.scenes.forEach((scene, index) => {
            const sceneItem = document.createElement('div');
            sceneItem.style.display = "flex";
            sceneItem.style.alignItems = "center";
            sceneItem.style.border = "1px solid #666";
            sceneItem.style.padding = "3px";
            sceneItem.style.margin = "3px 0";
            sceneItem.innerHTML = `
              <button onclick="Scenes.recallSceneForGroup('${group.id}', ${index})" title="Recall Scene" style="font-size: 1.2em; cursor: pointer; padding: 4px 6px; border: 1px solid #ccc; border-radius: 3px; background: #f0f0f0;">►</button>
              <span class="scene-settings">${scene.transitionTime}${scene.flash ? " *" : ""}</span>
              <span class="scene-name"><strong>${scene.name}</strong></span>
              <button onclick="Scenes.deleteSceneForGroup('${group.id}', ${index})" title="Delete Scene" style="background: red; color: white; border: none; cursor: pointer; margin-left: 5px; font-size: 0.6em; padding: 2px 4px;">X</button>
            `;
            scenesList.appendChild(sceneItem);
          });
        }
        sceneDiv.appendChild(scenesList);
        return sceneDiv;
      },
      createDropzoneElement: function(group) {
        const dropzone = document.createElement('div');
        dropzone.className = "group-dropzone";
        dropzone.addEventListener('dragover', e => e.preventDefault());
        dropzone.addEventListener('drop', e => {
          e.preventDefault();
          e.stopPropagation();
          GroupManager.groupDrop(e, group.id);
        });
        const filterText = AppState.dom.lightFilter.value.toLowerCase();
        group.lights.forEach(lightId => {
          const light = AppState.discoveredLights[lightId];
          if (light && light.name.toLowerCase().includes(filterText)) {
            dropzone.appendChild(this.createLightElement(lightId, light));
          }
        });
        return dropzone;
      },
      // added v4.9 nik to create a selector element for the light
      createLightElement: function(lightId, light) {
        const div = document.createElement('div');
        div.className = "light-control";
        div.draggable = true;
        div.id = `light-${lightId}`;
        
        // Ensure each light has a default "selected" property.
        if (typeof light.selected === "undefined") {
            light.selected = true;
        }
        
        div.innerHTML = `
            <h4>${light.name}</h4>
            <div class="light-controls">
            <button onclick="toggleLight('${lightId}', this)"> ${light.state.on ? "Turn Off" : "Turn On"} </button>
            <input type="range" min="1" max="254" value="${light.state.bri}" onchange="updateLight('${lightId}', this.value)">
            </div>
        `;
        
        // Add a check square indicator.
        const selector = document.createElement('div');
        selector.style.position = "absolute";
        selector.style.top = "5px";
        selector.style.right = "5px";
        selector.style.width = "16px";
        selector.style.height = "16px";
        selector.style.border = "2px solid #555";
        selector.style.cursor = "pointer";
        selector.style.backgroundColor = light.selected ? "#000" : "transparent";
        selector.title = "Toggle light selection";
        
        // Toggle selection on click.
        selector.addEventListener("click", function(e) {
            e.stopPropagation();
            light.selected = !light.selected;
            // Update the indicator appearance.
            selector.style.backgroundColor = light.selected ? "#000" : "transparent";
        });
        
        // Ensure the container div provides a relative positioning context.
        div.style.position = "relative";
        div.appendChild(selector);
        
        this.updateLightShading(lightId, div);
        div.sliderActive = false;
        const slider = div.querySelector('input[type="range"]');
        Utils.attachSliderHandlers(slider, div);
        div.addEventListener('dragstart', e => {
            if (div.sliderActive) { e.preventDefault(); return; }
            e.stopPropagation();
            e.dataTransfer.setData("text/plain", `light:${div.id.replace("light-", "")}`);
        });
        return div;
        }
,
      updateLightShading: function(lightId, el) {
        const light = AppState.discoveredLights[lightId];
        const div = el || document.getElementById(`light-${lightId}`);
        if (!div || !light) return;
        if (light.state.on) {
          if (light.state.hue !== undefined && light.state.sat !== undefined) {
            const hueDeg = (light.state.hue / 65535) * 360;
            const satPct = (light.state.sat / 254) * 100;
            const lightness = (light.state.bri / 254) * 50 + 25;
            div.style.backgroundColor = `hsl(${hueDeg}, ${satPct}%, ${lightness}%)`;
          } else if (light.state.ct !== undefined) {
            const baseColor = light.state.ct >= 300 ? "#FFF4E5" : "#E0F0FF";
            let factor = light.state.bri / 254;
            factor = Math.max(factor, 0.3);
            div.style.backgroundColor = Utils.darkenColor(baseColor, factor);
          } else {
            const percent = light.state.bri / 254;
            const lightness = 30 + 40 * percent;
            div.style.backgroundColor = `hsl(50, 100%, ${lightness}%)`;
          }
        } else {
          div.style.backgroundColor = "#aaa";
        }
      },
      makeGroupTitleEditable: function(titleEl, group) {
        const originalName = group.name;
        const input = document.createElement('input');
        input.type = "text";
        input.value = group.name;
        input.style.fontSize = "1.1em";
        input.addEventListener('mousedown', e => e.stopPropagation());
        input.addEventListener('touchstart', e => e.stopPropagation());
        input.addEventListener('keydown', function(e) {
          if (e.key === 'Enter') {
            e.preventDefault();
            input.blur();
          }
          if (e.key === 'Escape') {
            input.value = originalName;
            input.blur();
          }
        });
        input.addEventListener('blur', function() {
          let newName = input.value.trim();
          if (newName === "") {
            newName = originalName;
          }
          newName = Utils.getUniqueName(newName, group.id);
          group.name = newName;
          titleEl.innerText = newName;
          titleEl.style.display = "";
          input.remove();
          GroupManager.saveGroupsToStorage();
        });
        titleEl.style.display = "none";
        titleEl.parentNode.insertBefore(input, titleEl);
        input.focus();
        input.select();
      },
      groupDropOnGroup: function(e) {
        e.preventDefault();
        const draggedData = e.dataTransfer.getData("text/plain");
        if (draggedData.startsWith("group:")) {
          const draggedGroupId = draggedData.split(":")[1];
          const targetGroupId = e.currentTarget.id;
          GroupManager.reorderGroups(draggedGroupId, targetGroupId);
          this.renderGroups();
        }
      },
      togglePanel: function() {
        AppState.dom.flyoutPanel.classList.toggle('open');
      },
      updateDarkMode: function(val) {
        AppState.darkMode = val;
        document.body.className = `theme-${val}`;
        GroupManager.saveGroupsToStorage();
      }
    };

    /*******************************
     * Scenes Module               *
     *******************************/
     const Scenes = {
      saveSceneForGroup: function(groupId) {
        const group = AppState.groups.find(g => g.id === groupId);
        if (!group) return;
        const nameInput = document.getElementById(`scene-name-${groupId}`);
        const transInput = document.getElementById(`scene-transition-${groupId}`);
        const flashInput = document.getElementById(`scene-flash-${groupId}`);
        const sceneName = nameInput.value.trim() || `Scene ${group.scenes.length + 1}`;
        const transitionTime = parseInt(transInput.value) || 10;
        const flash = flashInput.checked;
        const sceneLights = {};
        group.lights.forEach(lightId => {
          if (AppState.discoveredLights[lightId]) {
            const state = { ...AppState.discoveredLights[lightId].state };
            if (state.alert) delete state.alert;
            sceneLights[lightId] = state;
          }
        });
        const scene = { name: sceneName, transitionTime, flash, lights: sceneLights };
        if (!group.scenes) group.scenes = [];
        group.scenes.push(scene);
          // UIRenderer.renderGroups();
          scheduleRender();  // 5.1 added to debounce the render
      },
      deleteSceneForGroup: function(groupId, sceneIndex) {
        const group = AppState.groups.find(g => g.id === groupId);
        if (!group || !group.scenes) return;
        group.scenes.splice(sceneIndex, 1);
          // UIRenderer.renderGroups();
          scheduleRender();  // 5.1 added to debounce the render
      },
    /* new version in 5.0 */
      recallSceneForGroup: async function(groupId, sceneIndex) {
      // Find the group and scene based on the given IDs.
      const group = AppState.groups.find(g => g.id === groupId);
      if (!group || !group.scenes || !group.scenes[sceneIndex]) return;
      const scene = group.scenes[sceneIndex];

      // If there is an existing pending flash timer, cancel it first.
      FlashController.cancelPendingFlash(group);

      if (group.pendingFlashTimeout) {
        clearTimeout(group.pendingFlashTimeout);
        group.pendingFlashTimeout = null;
        console.log(`Pending flash timer for group ${group.id} cancelled.`);
      }

      if (scene.flash) {  // if we have a hub flash followed by a transition, we need to handle the flash separately
        // Step 1: Immediately send flash commands to all lights.
        const flashPromises = [];
        for (const lightId in scene.lights) {
          const state = scene.lights[lightId];
          flashPromises.push(
            HueAPI.updateLightState(lightId, { ...state, transitiontime: 1, alert: "lselect" }) // 5.2 changed transition from 0 to 1 to try and prevent strobing
          );
        }
        await Promise.all(flashPromises);

        // Step 2: Get the flash delay value (capped at 15 seconds).
        const flashDelay = Math.min(parseInt(AppState.dom.flashDelay.value) || 1000, 15000);

        // Step 3: Set a pending timer to perform the transition.
        group.pendingFlashTimeout = setTimeout(async () => {
          const transitionPromises = [];
          for (const lightId in scene.lights) {
            const state = scene.lights[lightId];
            transitionPromises.push(
              HueAPI.updateLightState(lightId, { ...state, transitiontime: scene.transitionTime, alert: "none" })
            );
          }
          await Promise.all(transitionPromises);
          
          // Clear the timer handle as it has now executed.
          group.pendingFlashTimeout = null;
          
          // Update the local state for each light.
          for (const lightId in scene.lights) {
            if (AppState.discoveredLights[lightId]) {
              AppState.discoveredLights[lightId].state = scene.lights[lightId];
            }
          }
          // UIRenderer.renderGroups();
          scheduleRender();  // 5.1 added to debounce the render
        }, flashDelay);
      } else {
        // If no flash is required, perform the transition immediately.
        const transitionPromises = [];
        for (const lightId in scene.lights) {
          const state = scene.lights[lightId];
          transitionPromises.push(
            HueAPI.updateLightState(lightId, { ...state, transitiontime: scene.transitionTime, alert: "none" })
          );
        }
        await Promise.all(transitionPromises);
        for (const lightId in scene.lights) {
          if (AppState.discoveredLights[lightId]) {
            AppState.discoveredLights[lightId].state = scene.lights[lightId];
          }
        }
        // UIRenderer.renderGroups();
        scheduleRender();  // 5.1 added to debounce the render

      }
    },   /* end of new version */ 


      createSceneManagementElement: function(group) {
        const sceneDiv = document.createElement('div');
        sceneDiv.id = "scene-management-" + group.id;
        sceneDiv.style.borderTop = "1px solid #888";
        sceneDiv.style.marginTop = "10px";
        sceneDiv.style.paddingTop = "5px";
        const controlsDiv = document.createElement('div');
        controlsDiv.innerHTML = `
          <input type="text" id="scene-name-${group.id}" placeholder="Scene name" style="width:120px;">
          <input type="number" id="scene-transition-${group.id}" placeholder="Time" style="width:50px;" value="10">
          <label style="font-size:0.9em;"><input type="checkbox" id="scene-flash-${group.id}"> Flash</label>
          <button onclick="Scenes.saveSceneForGroup('${group.id}')">Save</button>
        `;
        sceneDiv.appendChild(controlsDiv);
        const scenesList = document.createElement('div');
        scenesList.id = "scenes-container-" + group.id;
        if (group.scenes && group.scenes.length > 0) {
          group.scenes.forEach((scene, index) => {
            const sceneItem = document.createElement('div');
            sceneItem.style.display = "flex";
            sceneItem.style.alignItems = "center";
            sceneItem.style.border = "1px solid #666";
            sceneItem.style.padding = "3px";
            sceneItem.style.margin = "3px 0";
            sceneItem.innerHTML = `
              <button onclick="Scenes.recallSceneForGroup('${group.id}', ${index})" title="Recall Scene" style="font-size: 1.2em; cursor: pointer; padding: 4px 6px; border: 1px solid #ccc; border-radius: 3px; background: #f0f0f0;">►</button>
              <span class="scene-settings">${scene.transitionTime}${scene.flash ? " *" : ""}</span>
              <span class="scene-name"><strong>${scene.name}</strong></span>
              <button onclick="Scenes.deleteSceneForGroup('${group.id}', ${index})" title="Delete Scene" style="background: red; color: white; border: none; cursor: pointer; margin-left: 5px; font-size: 0.6em; padding: 2px 4px;">X</button>
            `;
            scenesList.appendChild(sceneItem);
          });
        }
        sceneDiv.appendChild(scenesList);
        return sceneDiv;
      }
    };


    // --------------------------
    // Helper Functions for Chase Effects
    // --------------------------

    // Turns off all lights in the provided array.
    function turnOffAllLights(lights) {
    lights.forEach(lightId => {
        // Send API call to turn off the light immediately.
        HueAPI.updateLightState(lightId, { on: false, transitiontime: 0 });
        // Update local state if available.
        if (AppState.discoveredLights[lightId]) {
        AppState.discoveredLights[lightId].state.on = false;
        }
    });
    }

    // Turns on a single light using the specified brightness.
    // Use the brightness from the group (group.lastBrightness) rather than a hard-coded value.
    function turnOnLight(lightId, brightness) {
    HueAPI.updateLightState(lightId, { on: true, bri: brightness, transitiontime: 0 });
        if (AppState.discoveredLights[lightId]) {
            AppState.discoveredLights[lightId].state.on = true;
            AppState.discoveredLights[lightId].state.bri = brightness;
        }
    }

    // --------------------------
    // Effects Module (Updated Chase Logic for v5.2 with additonal helpers)
    // --------------------------
    const Effects = {
    _chaseState: {},
    
    startChase: function(groupId) {
        const group = AppState.groups.find(g => g.id === groupId);
        if (!group || group.chaseMode === "off") return;
        if (this._chaseState[groupId] && this._chaseState[groupId].timerId) return;
        // Initialize chase state with currentIndex and direction.
        this._chaseState[groupId] = { currentIndex: 0, direction: 1 };
        const interval = group.speed > 0 ? (60000 / group.speed) : 500;
        this._chaseState[groupId].timerId = setInterval(() => { this.applyChase(groupId); }, interval);
    },
    
    stopChase: function(groupId) {
        if (this._chaseState[groupId] && this._chaseState[groupId].timerId) {
        clearInterval(this._chaseState[groupId].timerId);
        delete this._chaseState[groupId];
        }
    },
    
    // Updated applyChase function with simplified helper calls and proper brightness handling.
    applyChase: function(groupId) {
        const group = AppState.groups.find(g => g.id === groupId);
        if (!group) return;
        const chaseState = this._chaseState[groupId];
        if (!chaseState) return;
        const lights = group.lights;
        if (lights.length === 0) return;
        
        // Use group.lastBrightness for the brightness level; default to 254 if not set.
        const brightness = group.lastBrightness || 254;
        
        // Chase modes:

        if (group.chaseMode === "rotate") {
        // Capture the full state of each light in the group.
        // Instead of just capturing "on/off" status, we include all properties (brightness, color, etc.)
        let pattern = lights.map(lightId => {
            const light = AppState.discoveredLights[lightId];
            // If a light exists, copy its current state; otherwise, default to off.
            return light ? { ...light.state } : { on: false, transitiontime: 1 }; // 0 transition is a bit glitchy - use 1 instead
        });

        // Rotate the entire pattern: take the last element and move it to the front.
        pattern.unshift(pattern.pop());

        // Override the transitiontime for each state's update to 1 decisecond (for a faster transition)
        pattern = pattern.map(state => ({ ...state, transitiontime: 1 })); // 1 decisecond = 100ms    

        // Now update each light with its corresponding rotated state.
        lights.forEach((lightId, index) => {
            const newState = pattern[index];
            // Send the update to the Hue API.
            HueAPI.updateLightState(lightId, newState);
            // Update the local state for the light.
            if (AppState.discoveredLights[lightId]) {
            AppState.discoveredLights[lightId].state = { 
                ...AppState.discoveredLights[lightId].state, 
                ...newState 
            };
            }
        });
        }
        else if (group.chaseMode === "right") {
        // RIGHT mode: turn off all lights, then turn on the light at the current index with group brightness.
        turnOffAllLights(lights);
        const idx = chaseState.currentIndex % lights.length;
        turnOnLight(lights[idx], brightness);
        chaseState.currentIndex = (chaseState.currentIndex + 1) % lights.length;
        }
        else if (group.chaseMode === "left") {
        // LEFT mode: turn off all lights, then turn on the light at the current index with group brightness,
        // then decrement the index (wrapping around if needed).
        turnOffAllLights(lights);
        const idx = chaseState.currentIndex % lights.length;
        turnOnLight(lights[idx], brightness);
        // Decrement index; add lights.length before mod to ensure a positive result.
        chaseState.currentIndex = (chaseState.currentIndex - 1 + lights.length) % lights.length;
        }
        else if (group.chaseMode === "classic") {
        // CLASSIC mode: turn off all lights, then turn on two consecutive lights.
        turnOffAllLights(lights);
        const idx1 = chaseState.currentIndex % lights.length;
        const idx2 = (chaseState.currentIndex + 1) % lights.length;
        turnOnLight(lights[idx1], brightness);
        turnOnLight(lights[idx2], brightness);
        chaseState.currentIndex = (chaseState.currentIndex + 1) % lights.length;
        }
// new ripple mode with fading trail 
        else if (group.chaseMode === "ripple") {
        // RIPPLE mode: Create a trailing effect with a trail of 3 lights.
        // The brightness for each light is calculated based on the group’s baseline brightness:
        //   Leading light: 100% (multiplier = 1.0)
        //   Second light: 60% (multiplier = 0.6)
        //   Third light: 10% (multiplier = 0.1)

        // Ensure a trail array exists in chaseState.
        if (!chaseState.trail) {
            chaseState.trail = [];
        }
        
        // Determine the current light index from the group.
        const currentIdx = chaseState.currentIndex % lights.length;
        
        // Add the current index to the trail.
        chaseState.trail.push(currentIdx);
        
        // If the trail length exceeds 3, remove the oldest light and turn it off.
        if (chaseState.trail.length > 3) {
            const idxToTurnOff = chaseState.trail.shift();
            HueAPI.updateLightState(lights[idxToTurnOff], { on: false, transitiontime: 0 });
            if (AppState.discoveredLights[lights[idxToTurnOff]]) {
            AppState.discoveredLights[lights[idxToTurnOff]].state.on = false;
            }
        }
        // Determine the baseline brightness from the group settings.
        const baseline = group.lastBrightness || 254;
        const len = chaseState.trail.length; // Current number of lights in the trail

        // Iterate over the trail and update each light with its corresponding brightness multiplier.
        // If there's only one light in the trail, it gets 100% brightness.
        // If there are two lights, assign: first gets 60%, second gets 100%.
        // If there are three lights, assign: first gets 10%, second 60%, and third (leading) 100%.
        chaseState.trail.forEach((trailIdx, i) => {
            let multiplier = 1.0; // Default for a single light.
            if (len === 1) {
            multiplier = 1.0;
            } else if (len === 2) {
            multiplier = (i === 0) ? 0.6 : 1.0;
            } else if (len === 3) {
            if (i === 0) multiplier = 0.1;
            else if (i === 1) multiplier = 0.6;
            else if (i === 2) multiplier = 1.0;
            }
            // Update this light using the calculated brightness.
            turnOnLight(lights[trailIdx], Math.round(baseline * multiplier));
        });
        
        // Advance the chase index for the next cycle.
        chaseState.currentIndex = (chaseState.currentIndex + 1) % lights.length;
        }

        else if (group.chaseMode === "ping-pong") {
        // PING-PONG mode: update the index based on direction.
        if (chaseState.currentIndex === 0) { chaseState.direction = 1; }
        else if (chaseState.currentIndex === lights.length - 1) { chaseState.direction = -1; }
        turnOffAllLights(lights);
        const idx = chaseState.currentIndex % lights.length;
        turnOnLight(lights[idx], brightness);
        chaseState.currentIndex += chaseState.direction;
        }
        else {
        // Fallback: simply increment the index.
        chaseState.currentIndex = (chaseState.currentIndex + 1) % lights.length;
        }
        
        // Request a UI update (for example, to update light shading in the interface)
        requestAnimationFrame(() => updateChaseUI(groupId));
    },
    
    updateChaseState: function(groupId) {
        const group = AppState.groups.find(g => g.id === groupId);
        if (!group) return;
        if (group.chaseMode !== "off") { this.startChase(groupId); }
        else { this.stopChase(groupId); }
    }
    };


    // Helper function: update only the lights' UI during chase (instead of full group re-render)
    function updateChaseUI(groupId) {
      const group = AppState.groups.find(g => g.id === groupId);
      if (!group) return;
      group.lights.forEach(lightId => {
        const lightEl = document.getElementById(`light-${lightId}`);
        if (lightEl) { UIRenderer.updateLightShading(lightId, lightEl); }
      });
    }

    /*******************************
     * Rainbow Picker Initialization *
     *******************************/
    function initializeRainbowPicker(groupId) {
      const canvas = document.getElementById(`rainbow-picker-${groupId}`);
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      const gradient = ctx.createLinearGradient(0, 0, canvas.width, 0);
      gradient.addColorStop(0, "red");
      gradient.addColorStop(0.17, "orange");
      gradient.addColorStop(0.33, "yellow");
      gradient.addColorStop(0.5, "green");
      gradient.addColorStop(0.67, "blue");
      gradient.addColorStop(0.83, "indigo");
      gradient.addColorStop(1, "violet");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      canvas.addEventListener("click", function(event) {
        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        const pixel = ctx.getImageData(x, y, 1, 1).data;
        const rgb = `rgb(${pixel[0]}, ${pixel[1]}, ${pixel[2]})`;
        const preview = document.getElementById(`selected-color-preview-${groupId}`);
        if (preview) { preview.style.backgroundColor = rgb; }
        GroupManager.groupSetColor(groupId, rgb);
      });
    }

    /*******************************
     * Additional Global Functions *
     *******************************/
    function authenticate() { HueAPI.authenticate(); }
    function discoverLights() { HueAPI.discoverLights(); }
    function refreshLightStatus() { HueAPI.refreshLightStatus(); }
    function toggleMockMode(enabled) {
      AppState.useMock = enabled;
      localStorage.setItem('useMock', enabled ? "true" : "false");
      AppState.dom.useMock.checked = enabled;
      AppState.dom.authStatus.innerText = enabled ? "Mock mode enabled." : "";
      if (enabled) {
        AppState.username = "mock-user";
        AppState.bridgeIP = "mock";
      }
    }
    function toggleLight(lightId, btn) {
      const light = AppState.discoveredLights[lightId];
      const newState = { on: !light.state.on };
      HueAPI.updateLightState(lightId, newState).then(() => {
        light.state.on = !light.state.on;
        btn.innerText = light.state.on ? "Turn Off" : "Turn On";
        UIRenderer.updateLightShading(lightId);
      });
    }
    function updateLight(lightId, brightness) {
      const newBri = parseInt(brightness);
      HueAPI.updateLightState(lightId, { bri: newBri }).then(() => {
        AppState.discoveredLights[lightId].state.bri = newBri;
        UIRenderer.updateLightShading(lightId);
      });
    }

    document.addEventListener('drop', e => {
      const data = e.dataTransfer.getData("text/plain");
      if (data.startsWith("light:")) {
        const path = e.composedPath ? e.composedPath() : [e.target];
        const inGroup = path.some(el => el.classList && (
          el.classList.contains("group-dropzone") ||
          el.classList.contains("group-header")
        ));
        if (!inGroup) {
          e.preventDefault();
          e.stopPropagation();
          const lightId = data.split(":")[1];
          GroupManager.removeLightFromAllGroups(lightId);
          const unassigned = AppState.groups.find(g => g.id === "group-unassigned");
          if (unassigned && !unassigned.lights.includes(lightId)) { unassigned.lights.push(lightId); }
          // UIRenderer.renderGroups();
          scheduleRender();  // 5.1 added to debounce the render
        }
      }
    }, true);

    async function autoRefreshLights() { await HueAPI.refreshLightStatus(); }

    /*******************************
     * Initialization              *
     *******************************/
    window.onload = function() {
      const storedIP = localStorage.getItem('hueBridgeIP');
      const storedUsername = localStorage.getItem('hueUsername');
      GroupManager.loadGroupsFromStorage();
      if (storedIP) {
        AppState.dom.bridgeInput.value = storedIP;
        AppState.bridgeIP = storedIP;
      }
      if (storedUsername) {
        AppState.username = storedUsername;
        AppState.dom.authStatus.innerText = "Authenticated.";
        discoverLights();
      }
      setInterval(autoRefreshLights, 60000);
    };
