<script lang="ts">
	import { onMount } from "svelte";

	let { lang = "en" }: { lang?: string } = $props();
	let container: HTMLElement;

	onMount(() => {
		const theme = document.documentElement.classList.contains("dark")
			? "dark"
			: "light";

		const script = document.createElement("script");
		script.src = "https://giscus.app/client.js";
		script.setAttribute("data-repo", "typhoon1217/typhoon-blog");
		script.setAttribute("data-repo-id", "R_kgDOSCBEdw");
		script.setAttribute("data-category", "General");
		script.setAttribute("data-category-id", "DIC_kwDOSCBEd84C6zzG");
		script.setAttribute("data-mapping", "pathname");
		script.setAttribute("data-strict", "0");
		script.setAttribute("data-reactions-enabled", "1");
		script.setAttribute("data-emit-metadata", "0");
		script.setAttribute("data-input-position", "top");
		script.setAttribute("data-theme", theme);
		script.setAttribute("data-lang", lang);
		script.setAttribute("data-loading", "lazy");
		script.setAttribute("crossorigin", "anonymous");
		script.async = true;
		container.appendChild(script);

		// Sync theme changes to the Giscus iframe
		const observer = new MutationObserver(() => {
			const newTheme = document.documentElement.classList.contains("dark")
				? "dark"
				: "light";
			const iframe =
				document.querySelector<HTMLIFrameElement>("iframe.giscus-frame");
			iframe?.contentWindow?.postMessage(
				{ giscus: { setConfig: { theme: newTheme } } },
				"https://giscus.app",
			);
		});
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["class"],
		});

		return () => observer.disconnect();
	});
</script>

<div bind:this={container} class="mt-6 giscus-wrapper"></div>
