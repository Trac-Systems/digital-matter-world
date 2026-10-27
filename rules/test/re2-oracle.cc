#include <iostream>
#include <string>
#include <re2/re2.h>
int main() {
  std::string pattern; unsigned count = 0;
  while (std::getline(std::cin, pattern)) {
    RE2 re(pattern); if (!re.ok()) return 1; ++count;
  }
  std::cout << "accepted " << count << '\n';
}
