<script setup lang="ts">
/**
 * Login page
 *
 * Uses the auth store for the login API call, and Nuxt UI for form components.
 * After a successful login, navigateTo('/') is called automatically.
 */

import { useAuthStore } from '~/stores/auth'

// Redirect already-logged-in users away from this page
definePageMeta({ middleware: 'guest' })

useHead({ title: 'Log In' })

const auth = useAuthStore()
const toast = useToast()

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

    <!-- ── Login Form ─────────────────────────────────────────────────── -->
    <form
      method="post"
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

  </div>
</template>
