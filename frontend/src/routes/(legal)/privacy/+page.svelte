<script lang="ts">
	import LegalDocument from "$lib/components/legal/LegalDocument.svelte";

	const UPDATED = "2 June 2026";

	function openCookieSettings() {
		window.dispatchEvent(new CustomEvent("comic-workspace:open-cookie-settings"));
	}
</script>

<svelte:head>
	<title>Privacy Policy — Comic Workspace</title>
	<meta
		name="description"
		content="How Comic Workspace collects, uses, shares and protects your personal data, and the rights you have under GDPR, CCPA/CPRA and PDPA."
	/>
</svelte:head>

<LegalDocument
	title="Privacy Policy"
	updated={UPDATED}
	summary="Plain-language summary (not a substitute for the full policy): We collect the data needed to run your account, your workspace and AI features, plus optional analytics you can switch off. We don't sell your personal data. We use trusted processors (hosting, payments, email, AI) under contract. You have rights to access, correct, delete and port your data, and to object to or restrict certain processing."
>
	<p>
		This Privacy Policy explains how Comic Workspace (&ldquo;we&rdquo;, &ldquo;us&rdquo;, &ldquo;our&rdquo;)
		collects, uses, discloses and protects personal data when you use our manga and webtoon translation
		workspace (the &ldquo;Service&rdquo;). It is designed to meet our obligations under the EU/UK General Data
		Protection Regulation (&ldquo;GDPR&rdquo;), the California Consumer Privacy Act as amended by the CPRA
		(&ldquo;CCPA&rdquo;), and Thailand&rsquo;s Personal Data Protection Act (&ldquo;PDPA&rdquo;), among other
		applicable laws.
	</p>

	<h2>1. Who is responsible for your data (Controller)</h2>
	<p>
		For account, billing and product-improvement data, Comic Workspace acts as the <strong>data
		controller</strong>. For the comic pages, translations and other content you upload into a workspace, we
		generally act as a <strong>data processor</strong> on behalf of the workspace owner, processing that
		content under our agreement with them and on their instructions.
		<em>(The named legal entity and any EU/UK representative will be confirmed with counsel before launch.)</em>
	</p>

	<h2>2. Data we collect</h2>
	<ul>
		<li><strong>Account data:</strong> name, email, password hash, language preference, profile settings.</li>
		<li><strong>Workspace &amp; collaboration data:</strong> workspace and project names, roles, task assignments, comments and activity.</li>
		<li><strong>Customer Content:</strong> images and text you upload or generate (source pages, translations, typeset layers).</li>
		<li><strong>Billing data:</strong> plan, transaction records and limited payment metadata. Card details are handled by our payment processor; we do not store full card numbers.</li>
		<li><strong>AI feature data:</strong> the text/images you submit to AI features and the resulting output, plus moderation results.</li>
		<li><strong>Technical data:</strong> IP address, device/browser type, log and security data.</li>
		<li><strong>Analytics data:</strong> aggregated, privacy-respecting usage metrics, collected only if you consent.</li>
	</ul>

	<h2>3. How and why we use data (purposes &amp; legal bases)</h2>
	<table>
		<thead>
			<tr>
				<th>Purpose</th>
				<th>GDPR legal basis</th>
			</tr>
		</thead>
		<tbody>
			<tr>
				<td>Provide and operate your account and workspace</td>
				<td>Performance of a contract</td>
			</tr>
			<tr>
				<td>Process payments and prevent fraud</td>
				<td>Contract / legitimate interests / legal obligation</td>
			</tr>
			<tr>
				<td>Run AI translation, detection and cleanup features</td>
				<td>Performance of a contract</td>
			</tr>
			<tr>
				<td>Content safety and moderation</td>
				<td>Legitimate interests / legal obligation</td>
			</tr>
			<tr>
				<td>Security, logging and abuse prevention</td>
				<td>Legitimate interests</td>
			</tr>
			<tr>
				<td>Product analytics and improvement</td>
				<td>Consent (you can withdraw it any time)</td>
			</tr>
			<tr>
				<td>Marketing communications</td>
				<td>Consent</td>
			</tr>
		</tbody>
	</table>

	<h2>4. AI processing</h2>
	<p>
		When you use AI features, the relevant text or images are sent to AI and content-moderation providers to
		generate output. We do not use your Customer Content to train our own foundation models, and we instruct
		our AI providers not to train on your data where that option is available. AI output may be inaccurate;
		review it before relying on it.
	</p>

	<h2>5. Cookies &amp; similar technologies</h2>
	<p>
		We use strictly necessary cookies to run the Service (sign-in, security, saving your work) and, only with
		your consent, analytics and marketing cookies. You can review or change your choices at any time using
		<button type="button" class="inline-link" onclick={openCookieSettings}>Cookie settings</button>.
		Necessary cookies cannot be switched off because the Service cannot function without them.
	</p>

	<h2>6. Sharing &amp; disclosures</h2>
	<p>We share personal data only with:</p>
	<ul>
		<li><strong>Service providers (processors)</strong> under contract — cloud hosting, payment processing, transactional email delivery, and AI providers;</li>
		<li><strong>Collaborators</strong> you or a workspace owner authorize to access shared content;</li>
		<li><strong>Authorities</strong> where required by law or to protect rights, safety and the Service.</li>
	</ul>
	<p>
		<strong>We do not sell your personal data, and we do not &ldquo;share&rdquo; it for cross-context behavioural
		advertising</strong> as those terms are defined under the CCPA/CPRA.
	</p>

	<h2>7. International transfers</h2>
	<p>
		We may process data in countries other than yours. Where we transfer personal data out of the EEA, UK or
		Thailand, we rely on appropriate safeguards such as the European Commission&rsquo;s Standard Contractual
		Clauses (and the UK Addendum) or an adequacy decision.
	</p>

	<h2>8. Data retention</h2>
	<p>
		We keep personal data for as long as your account is active and as needed to provide the Service, then for
		a limited period to meet legal, accounting and security obligations. Customer Content is deleted on your
		instruction or when your account is closed, subject to routine backup-retention cycles after which residual
		copies are purged.
	</p>

	<h2>9. Your rights</h2>
	<p>Depending on where you live, you may have the right to:</p>
	<ul>
		<li>access the personal data we hold about you, and receive a copy (portability);</li>
		<li>correct inaccurate data;</li>
		<li>delete your data (&ldquo;right to be forgotten&rdquo;);</li>
		<li>restrict or object to certain processing, including profiling;</li>
		<li>withdraw consent at any time (e.g. for analytics or marketing), without affecting prior processing;</li>
		<li>under the CCPA/CPRA: know, delete, correct, and opt out of sale/sharing (we do not sell or share), and not be discriminated against for exercising your rights;</li>
		<li>under the PDPA: access, rectification, erasure, restriction, portability and to lodge a complaint.</li>
	</ul>
	<p>
		To exercise any right, contact <a href="mailto:privacy@example.com">privacy@example.com</a>.
		We will respond within the timeframe required by applicable law. You also have the right to lodge a complaint
		with your local data-protection authority.
	</p>

	<h2>10. Security</h2>
	<p>
		We use technical and organizational measures including encryption in transit, access controls, role-based
		permissions and logging to protect personal data. No system is perfectly secure; if a breach affects your
		data, we will notify you and the relevant authorities where required by law.
	</p>

	<h2>11. Children</h2>
	<p>
		The Service is not directed to children under 16 (or the age of digital consent in your country), and we do
		not knowingly collect their personal data. If you believe a child has provided us data, contact us so we can
		delete it.
	</p>

	<h2>12. Changes to this policy</h2>
	<p>
		We may update this Privacy Policy. If we make material changes, we will provide reasonable notice (for
		example by email or in-app notice) before they take effect.
	</p>

	<h2>13. Contact &amp; Data Protection Officer</h2>
	<p>
		Privacy questions or requests: <a href="mailto:privacy@example.com">privacy@example.com</a>.
		<em>(A Data Protection Officer / EU representative will be designated where legally required, to be confirmed
		with counsel before launch.)</em>
	</p>
</LegalDocument>

<style>
	.inline-link {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		color: #8fb8ff;
		text-decoration: underline;
		cursor: pointer;
	}

	.inline-link:focus-visible {
		outline: 2px solid var(--color-ws-accent, #7c5cff);
		outline-offset: 2px;
	}
</style>
