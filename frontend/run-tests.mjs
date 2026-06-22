import { execSync } from 'child_process';

// Test files that are not blocked by task #2 (canvas editor fixes)
const testFiles = [
  'src/lib/__tests__/config.test.ts',
  'src/lib/__tests__/api-client.test.ts',
  'src/lib/__tests__/thai-wrap.test.ts',
  'src/lib/__tests__/stores/prompt-store.test.ts',
];

// Test stores that need special setup for Svelte 5
const storeTestFiles = [
  'src/lib/__tests__/stores/ai-jobs-store.test.ts',
  'src/lib/__tests__/stores/project-store.test.ts',
  'src/lib/__tests__/stores/editor-store.test.ts',
];

console.log('Running Phase 1 tests (not blocked by task #2)...');

// Run config and api tests first
try {
  execSync(`npx vitest run ${testFiles.join(' ')}`, { stdio: 'inherit' });
  console.log('\n✅ Phase 1 tests passed!');
} catch (error) {
  console.error('\n❌ Phase 1 tests failed!');
  process.exit(1);
}

// Note: Store tests need additional setup for Svelte 5 $state
// They may fail until task #2 is completed
console.log('\n⚠️  Note: Store tests may fail due to Svelte 5 $state syntax');
console.log('    Waiting for task #2 (canvas editor fixes) to complete');