import { defineStore } from "pinia";
import { ref } from "vue";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export const useAiChatStore = defineStore("aiChat", () => {
  const conversations = ref<Conversation[]>([]);
  const activeConversationId = ref<string | null>(null);

  const activeConversation = ref<Conversation | null>(null);

  function createConversation(title = "新对话") {
    const conversation: Conversation = {
      id: crypto.randomUUID(),
      title,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    conversations.value.unshift(conversation);
    activeConversationId.value = conversation.id;
    activeConversation.value = conversation;
    persistConversations();
    return conversation;
  }

  function setActiveConversation(id: string) {
    activeConversationId.value = id;
    activeConversation.value = conversations.value.find((c) => c.id === id) || null;
  }

  function addMessage(role: "user" | "assistant", content: string) {
    if (!activeConversation.value) {
      createConversation();
    }

    const message: ChatMessage = {
      id: crypto.randomUUID(),
      role,
      content,
      timestamp: Date.now(),
    };

    activeConversation.value!.messages.push(message);
    activeConversation.value!.updatedAt = Date.now();

    if (role === "user" && activeConversation.value!.messages.length === 1) {
      activeConversation.value!.title = content.slice(0, 30);
    }

    persistConversations();
  }

  function deleteConversation(id: string) {
    conversations.value = conversations.value.filter((c) => c.id !== id);
    if (activeConversationId.value === id) {
      activeConversationId.value = null;
      activeConversation.value = null;
    }
    persistConversations();
  }

  function persistConversations() {
    try {
      localStorage.setItem("rein-ai-conversations", JSON.stringify(conversations.value));
    } catch {
      // storage full
    }
  }

  function loadConversations() {
    try {
      const saved = localStorage.getItem("rein-ai-conversations");
      if (saved) {
        conversations.value = JSON.parse(saved);
      }
    } catch {
      // corrupted data
    }
  }

  return {
    conversations,
    activeConversationId,
    activeConversation,
    createConversation,
    setActiveConversation,
    addMessage,
    deleteConversation,
    persistConversations,
    loadConversations,
  };
});
