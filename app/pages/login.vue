<script setup lang="ts">
/**
 * Login / Register page
 *
 * A single page with two tabs: "Sign in" and "Create account".
 * Uses the auth store for all API calls, and Nuxt UI for form components.
 *
 * After a successful login or registration, navigateTo('/') is called
 * automatically from the auth store.
 */

import { useAuthStore } from '~/stores/auth'

// Redirect already-logged-in users away from this page
definePageMeta({ middleware: 'guest' })

const auth = useAuthStore()
const toast = useToast()

// ── Tab state ────────────────────────────────────────────────────────────
type Tab = 'login' | 'register'
const activeTab = ref<Tab>('login')

// ── Login form ───────────────────────────────────────────────────────────
const loginForm = reactive({ email: '', password: '' })
const loginLoading = ref(false)

async function handleLogin() {
  loginLoading.value = true
  try {
    await auth.login(loginForm.email, loginForm.password)
    await navigateTo('/')
  }
  catch (err: unknown) {
    const message = (err as { data?: { statusMessage?: string } })?.data?.statusMessage
      ?? 'Login failed. Please try again.'
    toast.add({ title: 'Login failed', description: message, color: 'error' })
  }
  finally {
    loginLoading.value = false
  }
}

// ── Register form ────────────────────────────────────────────────────────
const registerForm = reactive({ email: '', username: '', password: '', confirm: '' })
const registerLoading = ref(false)

async function handleRegister() {
  if (registerForm.password !== registerForm.confirm) {
    toast.add({ title: 'Passwords do not match', color: 'error' })
    return
  }
  if (registerForm.password.length < 8) {
    toast.add({ title: 'Password too short', description: 'Minimum 8 characters.', color: 'error' })
    return
  }

  registerLoading.value = true
  try {
    await auth.register(registerForm.email, registerForm.username, registerForm.password)
    await navigateTo('/')
  }
  catch (err: unknown) {
    const message = (err as { data?: { statusMessage?: string } })?.data?.statusMessage
      ?? 'Registration failed. Please try again.'
    toast.add({ title: 'Registration failed', description: message, color: 'error' })
  }
  finally {
    registerLoading.value = false
  }
}
</script>

<template>
  <!--
    Login page: full-screen white canvas, content centred with generous
    breathing room. No card chrome — the form floats directly on the page.
  -->
  <div class="min-h-screen flex flex-col items-center justify-center bg-white px-6">

    <!-- Wordmark -->
    <div class="mb-10 flex flex-col items-center text-center">
      <div class="mb-5 flex h-[72px] w-[72px] items-center justify-center rounded-2xl bg-gradient-to-br from-orange-50 to-orange-100 text-orange-600 shadow-sm">
        <BikeLogo :size="44" />
      </div>
      <h1 class="text-3xl font-extrabold tracking-tight text-stone-900">
        Sprocket
      </h1>
      <p class="mt-2 text-base text-stone-400">
        Track your training load &amp; form
      </p>
    </div>

    <!-- Tab switcher — segmented control -->
    <div class="mb-8 inline-flex gap-1 rounded-xl bg-stone-100 p-1">
      <button
        v-for="tab in [{ label: 'Sign in', value: 'login' }, { label: 'Create account', value: 'register' }]"
        :key="tab.value"
        type="button"
        class="rounded-lg px-5 py-2 text-sm transition-colors"
        :class="activeTab === tab.value
          ? 'bg-white font-semibold text-stone-900 shadow-sm'
          : 'font-medium text-stone-500 hover:text-stone-700'"
        @click="activeTab = tab.value as Tab"
      >
        {{ tab.label }}
      </button>
    </div>

    <!-- ── Login Form ─────────────────────────────────────────────────── -->
    <form
      v-if="activeTab === 'login'"
      @submit.prevent="handleLogin"
      class="w-full max-w-xs space-y-5"
    >
      <UFormField label="Email" name="email">
        <UInput
          v-model="loginForm.email"
          type="email"
          placeholder="you@example.com"
          autocomplete="email"
          required
          class="w-full"
          size="xl"
        />
      </UFormField>

      <UFormField label="Password" name="password">
        <UInput
          v-model="loginForm.password"
          type="password"
          placeholder="••••••••"
          autocomplete="current-password"
          required
          class="w-full"
          size="xl"
        />
      </UFormField>

      <UButton
        type="submit"
        :loading="loginLoading"
        block
        size="lg"
        class="mt-1 rounded-lg font-semibold"
      >
        Sign in
      </UButton>
    </form>

    <!-- ── Register Form ──────────────────────────────────────────────── -->
    <form
      v-else
      @submit.prevent="handleRegister"
      class="w-full max-w-xs space-y-5"
    >
      <UFormField label="Email" name="email">
        <UInput
          v-model="registerForm.email"
          type="email"
          placeholder="you@example.com"
          autocomplete="email"
          required
          class="w-full"
          size="xl"
        />
      </UFormField>

      <UFormField label="Username" name="username">
        <UInput
          v-model="registerForm.username"
          placeholder="your_name"
          autocomplete="username"
          required
          class="w-full"
          size="xl"
        />
      </UFormField>

      <UFormField label="Password" name="password">
        <UInput
          v-model="registerForm.password"
          type="password"
          placeholder="Min. 8 characters"
          autocomplete="new-password"
          required
          class="w-full"
          size="xl"
        />
      </UFormField>

      <UFormField label="Confirm password" name="confirm">
        <UInput
          v-model="registerForm.confirm"
          type="password"
          placeholder="Repeat password"
          autocomplete="new-password"
          required
          class="w-full"
          size="xl"
        />
      </UFormField>

      <UButton
        type="submit"
        :loading="registerLoading"
        block
        size="lg"
        class="mt-1 rounded-lg font-semibold"
      >
        Create account
      </UButton>
    </form>

  </div>
</template>
