<script lang="ts">
import { onMount } from "svelte";

let href = $state("/ko/");
let label = $state("한");

function updateFromPath() {
	const path = window.location.pathname;
	if (path.startsWith("/ko")) {
		href = path.replace(/^\/ko/, "/en") || "/en/";
		label = "EN";
	} else {
		href = path.replace(/^\/en/, "/ko") || "/ko/";
		label = "한";
	}
}

function setup() {
	updateFromPath();
	window.swup.hooks.on("page:view", updateFromPath);
}

onMount(() => {
	if (window?.swup?.hooks) {
		setup();
	} else {
		document.addEventListener("swup:enable", setup);
	}
});
</script>

<a
  {href}
  aria-label="Switch language"
  class="btn-plain scale-animation rounded-lg h-11 w-11 active:scale-90 flex items-center justify-center font-bold text-sm"
>
  {label}
</a>
